import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";

import type {
  BootstrapResponse,
  BrushConfig,
  CameraState,
  CameraSyncMeta,
  ClientRole,
  FogStroke,
  ServerToClientMessage,
  SessionSnapshot
} from "@shared/types";
import { fetchBootstrap, fetchSession, patchSession, uploadMap } from "./api";
import { fromServerFogState, applyStrokeToLocalFog, type LocalFogState } from "./fogClient";
import { loadMapSurface, type LoadedMapSurface } from "./mapLoader";
import { MapViewport } from "./MapViewport";
import { connectSocket, type SocketClient } from "./socket";

const DEFAULT_BRUSH: BrushConfig = {
  shape: "round",
  sizePx: 80,
  hardness: 0.6,
  mode: "reveal"
};

interface RectangleToolConfig {
  mode: BrushConfig["mode"];
  roundness: number;
  softness: number;
}

const DEFAULT_RECTANGLE_TOOL: RectangleToolConfig = {
  mode: "reveal",
  roundness: 0.08,
  softness: 0.08
};

function cloneFogState(fog: LocalFogState): LocalFogState {
  return {
    ...fog
  };
}

function roleFromPath(pathname: string): ClientRole {
  if (pathname.startsWith("/player")) {
    return "player";
  }

  return "dm";
}

function buildCameraSyncMeta(camera: CameraState, viewport: { width: number; height: number }): CameraSyncMeta {
  const zoom = Math.max(0.0001, camera.zoom);
  return {
    centerWorldX: camera.x + viewport.width / (2 * zoom),
    centerWorldY: camera.y + viewport.height / (2 * zoom),
    viewportWidth: viewport.width,
    viewportHeight: viewport.height
  };
}

function syncedCameraForViewport(
  camera: CameraState,
  cameraSync: CameraSyncMeta | null | undefined,
  viewport: { width: number; height: number }
): CameraState {
  if (!cameraSync) {
    return camera;
  }

  const baseZoom = Math.max(0.0001, camera.zoom);
  const referenceWidth = Math.max(1, cameraSync.viewportWidth || viewport.width);
  const referenceHeight = Math.max(1, cameraSync.viewportHeight || viewport.height);
  const widthScale = viewport.width / referenceWidth;
  const heightScale = viewport.height / referenceHeight;
  const scale = Number.isFinite(widthScale) && Number.isFinite(heightScale) ? Math.min(widthScale, heightScale) : 1;
  const zoom = Math.max(0.0001, baseZoom * (scale > 0 ? scale : 1));

  return {
    x: cameraSync.centerWorldX - viewport.width / (2 * zoom),
    y: cameraSync.centerWorldY - viewport.height / (2 * zoom),
    zoom
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fitAspect(bounds: { width: number; height: number }, targetAspect: number): { width: number; height: number } {
  if (!Number.isFinite(targetAspect) || targetAspect <= 0) {
    return bounds;
  }

  const boundsAspect = bounds.width / Math.max(1, bounds.height);
  const aspectDelta = Math.abs(boundsAspect - targetAspect) / Math.max(targetAspect, 0.0001);
  if (aspectDelta <= 0.001) {
    return bounds;
  }

  const widthFromHeight = bounds.height * targetAspect;
  if (widthFromHeight <= bounds.width) {
    return {
      width: Math.max(1, Math.min(bounds.width, Math.round(widthFromHeight))),
      height: Math.max(1, Math.round(bounds.height))
    };
  }

  const heightFromWidth = bounds.width / targetAspect;
  return {
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.min(bounds.height, Math.round(heightFromWidth)))
  };
}

export function App() {
  const role = useMemo(() => roleFromPath(window.location.pathname), []);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [loadedMap, setLoadedMap] = useState<LoadedMapSurface | null>(null);
  const [localFog, setLocalFog] = useState<LocalFogState | null>(null);
  const [camera, setCamera] = useState<CameraState>({ x: 0, y: 0, zoom: 1 });
  const [brush, setBrush] = useState<BrushConfig>(DEFAULT_BRUSH);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [drawSyncEnabled, setDrawSyncEnabled] = useState(true);
  const [queuedStrokeCount, setQueuedStrokeCount] = useState(0);
  const [dmTool, setDmTool] = useState<"brush" | "pan" | "rect">("brush");
  const [rectangleTool, setRectangleTool] = useState<RectangleToolConfig>(DEFAULT_RECTANGLE_TOOL);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight)
  });
  const [windowSize, setWindowSize] = useState<{ width: number; height: number }>({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight)
  });
  const [dmShellSize, setDmShellSize] = useState<{ width: number; height: number }>({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight)
  });

  const socketRef = useRef<SocketClient | null>(null);
  const queuedStrokesRef = useRef<FogStroke[]>([]);
  const viewportShellRef = useRef<HTMLElement | null>(null);
  const lastPublishedViewportRef = useRef<{ width: number; height: number } | null>(null);
  const syncLockRef = useRef<boolean>(true);
  const viewportSizeRef = useRef<{ width: number; height: number }>(viewportSize);
  const lastSocketMessageRef = useRef<number>(Date.now());

  useEffect(() => {
    if (role === "dm") {
      fetchBootstrap().then(setBootstrap).catch((bootstrapError: unknown) => {
        const message = bootstrapError instanceof Error ? bootstrapError.message : "Failed to fetch bootstrap";
        setError(message);
      });
    }

    fetchSession()
      .then((sessionSnapshot) => {
        setSnapshot(sessionSnapshot);
        if (role === "player" && sessionSnapshot.session.syncLock) {
          setCamera(
            syncedCameraForViewport(sessionSnapshot.session.camera, sessionSnapshot.session.cameraSync, viewportSize)
          );
        } else if (sessionSnapshot.session.syncLock || role === "player") {
          setCamera(sessionSnapshot.session.camera);
        }
      })
      .catch((sessionError: unknown) => {
        const message = sessionError instanceof Error ? sessionError.message : "Failed to fetch session";
        setError(message);
      });
  }, [role]);

  useEffect(() => {
    const onResize = (): void => {
      const nextWindowSize = {
        width: Math.max(1, window.innerWidth),
        height: Math.max(1, window.innerHeight)
      };
      setWindowSize(nextWindowSize);
      setViewportSize({
        width: nextWindowSize.width,
        height: nextWindowSize.height
      });
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (role !== "dm") {
      return;
    }

    const shell = viewportShellRef.current;
    if (!shell) {
      return;
    }

    const updateSize = (): void => {
      const rect = shell.getBoundingClientRect();
      setDmShellSize({
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height))
      });
    };

    const observer = new ResizeObserver(updateSize);
    observer.observe(shell);
    updateSize();

    return () => {
      observer.disconnect();
    };
  }, [role]);

  useEffect(() => {
    if (role !== "player" || !snapshot?.session.syncLock) {
      return;
    }

    setCamera(syncedCameraForViewport(snapshot.session.camera, snapshot.session.cameraSync, viewportSize));
  }, [role, snapshot?.session.syncLock, snapshot?.session.camera, snapshot?.session.cameraSync, viewportSize]);

  useEffect(() => {
    syncLockRef.current = snapshot?.session.syncLock ?? true;
  }, [snapshot?.session.syncLock]);

  useEffect(() => {
    viewportSizeRef.current = viewportSize;
  }, [viewportSize]);

  useEffect(() => {
    if (role !== "player") {
      return;
    }

    let cancelled = false;

    const resync = async (): Promise<void> => {
      try {
        const freshSnapshot = await fetchSession();
        if (cancelled) {
          return;
        }

        setSnapshot(freshSnapshot);
        if (freshSnapshot.session.syncLock) {
          setCamera(
            syncedCameraForViewport(
              freshSnapshot.session.camera,
              freshSnapshot.session.cameraSync,
              viewportSizeRef.current
            )
          );
        }
        lastSocketMessageRef.current = Date.now();
      } catch (resyncError: unknown) {
        if (cancelled) {
          return;
        }

        const message = resyncError instanceof Error ? resyncError.message : "Failed to re-sync player session";
        setError(message);
      }
    };

    const timer = window.setInterval(() => {
      const silenceMs = Date.now() - lastSocketMessageRef.current;
      if (!connected || silenceMs > 2_500) {
        void resync();
      }
    }, 1_500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connected, role]);

  useEffect(() => {
    if (!snapshot?.session.fogState) {
      setLocalFog(null);
      return;
    }

    const nextFog = fromServerFogState(snapshot.session.fogState);
    if (role === "dm" && queuedStrokesRef.current.length > 0) {
      for (const queuedStroke of queuedStrokesRef.current) {
        applyStrokeToLocalFog(nextFog, queuedStroke);
      }
    }

    setLocalFog(nextFog);
  }, [role, snapshot?.session.fogState]);

  useEffect(() => {
    const activeMap = snapshot?.activeMap;
    if (!activeMap) {
      setLoadedMap(null);
      return;
    }

    let cancelled = false;

    loadMapSurface(activeMap, snapshot?.session.pdfPage ?? 1)
      .then((surface) => {
        if (!cancelled) {
          setLoadedMap(surface);
        }
      })
      .catch((loadError: unknown) => {
        const message = loadError instanceof Error ? loadError.message : "Failed to load map";
        setError(message);
      });

    return () => {
      cancelled = true;
    };
  }, [snapshot?.activeMap?.id, snapshot?.session.pdfPage]);

  const handleSocketMessage = useCallback(
    (message: ServerToClientMessage) => {
      lastSocketMessageRef.current = Date.now();
      switch (message.type) {
        case "session.snapshot": {
          setSnapshot(message.payload);

          if (role === "dm") {
            if (message.payload.session.syncLock) {
              setCamera(message.payload.session.camera);
            }
          } else {
            setCamera((current) =>
              message.payload.session.syncLock
                ? syncedCameraForViewport(
                    message.payload.session.camera,
                    message.payload.session.cameraSync,
                    viewportSizeRef.current
                  )
                : current
            );
          }

          break;
        }

        case "dm.camera.set": {
          if (role === "player") {
            setCamera(
              syncedCameraForViewport(message.payload.camera, message.payload.cameraSync, viewportSizeRef.current)
            );
          } else if (syncLockRef.current) {
            setCamera(message.payload.camera);
          }
          break;
        }

        case "dm.syncLock.set": {
          setSnapshot((current) => {
            if (!current) {
              return current;
            }

            return {
              ...current,
              session: {
                ...current.session,
                syncLock: message.payload.syncLock
              }
            };
          });
          break;
        }

        case "dm.fog.stroke": {
          setLocalFog((current) => {
            if (!current) {
              return current;
            }

            const next = cloneFogState(current);
            applyStrokeToLocalFog(next, message.payload.stroke);
            return next;
          });
          break;
        }

        case "server.error": {
          setError(message.payload.message);
          break;
        }

        default:
          break;
      }
    },
    [role]
  );

  useEffect(() => {
    const socket = connectSocket({
      role,
      onStatus: (isConnected) => {
        setConnected(isConnected);
        if (isConnected) {
          lastPublishedViewportRef.current = null;
          setError(null);
        }
      },
      onMessage: handleSocketMessage,
      onError: setError
    });

    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [role, handleSocketMessage]);

  const sendDmMessage = useCallback((payload: Parameters<SocketClient["send"]>[0]) => {
    socketRef.current?.send(payload);
  }, []);

  const flushQueuedStrokes = useCallback(() => {
    if (role !== "dm" || !connected || queuedStrokesRef.current.length === 0) {
      return;
    }

    const pending = queuedStrokesRef.current;
    queuedStrokesRef.current = [];
    setQueuedStrokeCount(0);

    for (const stroke of pending) {
      sendDmMessage({
        type: "dm.fog.stroke",
        payload: { stroke }
      });
    }
  }, [connected, role, sendDmMessage]);

  useEffect(() => {
    if (role !== "dm" || !connected || !snapshot?.session.syncLock) {
      return;
    }

    const last = lastPublishedViewportRef.current;
    if (last && last.width === viewportSize.width && last.height === viewportSize.height) {
      return;
    }

    lastPublishedViewportRef.current = viewportSize;
    sendDmMessage({
      type: "dm.camera.set",
      payload: {
        camera,
        cameraSync: buildCameraSyncMeta(camera, viewportSize)
      }
    });
  }, [camera, connected, role, sendDmMessage, snapshot?.session.syncLock, viewportSize]);

  useEffect(() => {
    if (role !== "dm" || !drawSyncEnabled || queuedStrokeCount <= 0) {
      return;
    }

    flushQueuedStrokes();
  }, [drawSyncEnabled, flushQueuedStrokes, queuedStrokeCount, role]);

  const handleCameraChange = useCallback(
    (nextCamera: CameraState, sourceViewport?: { width: number; height: number }) => {
      setCamera(nextCamera);

      if (role !== "dm") {
        return;
      }

      if (!snapshot?.session.syncLock) {
        return;
      }

      const syncMeta = buildCameraSyncMeta(nextCamera, sourceViewport ?? viewportSize);

      sendDmMessage({
        type: "dm.camera.set",
        payload: {
          camera: nextCamera,
          cameraSync: syncMeta
        }
      });
    },
    [role, sendDmMessage, snapshot?.session.syncLock, viewportSize]
  );

  const setZoomLevel = useCallback(
    (requestedZoom: number) => {
      const nextZoom = clamp(requestedZoom, 0.15, 8);
      const currentZoom = Math.max(0.0001, camera.zoom);
      const centerWorldX = camera.x + viewportSize.width / (2 * currentZoom);
      const centerWorldY = camera.y + viewportSize.height / (2 * currentZoom);

      handleCameraChange(
        {
          x: centerWorldX - viewportSize.width / (2 * nextZoom),
          y: centerWorldY - viewportSize.height / (2 * nextZoom),
          zoom: nextZoom
        },
        viewportSize
      );
    },
    [camera, handleCameraChange, viewportSize]
  );

  const resetViewToMap = useCallback(() => {
    if (!loadedMap) {
      return;
    }

    const viewportWidth = Math.max(1, viewportSize.width);
    const viewportHeight = Math.max(1, viewportSize.height);
    const mapWidth = Math.max(1, loadedMap.width);
    const mapHeight = Math.max(1, loadedMap.height);

    const fitZoom = clamp(Math.min(viewportWidth / mapWidth, viewportHeight / mapHeight), 0.15, 8);
    const visibleWorldWidth = viewportWidth / fitZoom;
    const visibleWorldHeight = viewportHeight / fitZoom;

    handleCameraChange(
      {
        x: (mapWidth - visibleWorldWidth) / 2,
        y: (mapHeight - visibleWorldHeight) / 2,
        zoom: fitZoom
      },
      viewportSize
    );
  }, [handleCameraChange, loadedMap, viewportSize]);

  const applyLocalStroke = useCallback((stroke: FogStroke) => {
    setLocalFog((current) => {
      if (!current) {
        return current;
      }

      const next = cloneFogState(current);
      applyStrokeToLocalFog(next, stroke);
      return next;
    });
  }, []);

  const handleStroke = useCallback(
    (stroke: FogStroke) => {
      if (role !== "dm") {
        return;
      }

      applyLocalStroke(stroke);

      if (!drawSyncEnabled) {
        queuedStrokesRef.current = [...queuedStrokesRef.current, stroke];
        setQueuedStrokeCount(queuedStrokesRef.current.length);
        return;
      }

      sendDmMessage({
        type: "dm.fog.stroke",
        payload: { stroke }
      });
    },
    [applyLocalStroke, drawSyncEnabled, role, sendDmMessage]
  );

  const toggleDrawSync = useCallback(() => {
    if (role !== "dm") {
      return;
    }

    const nextEnabled = !drawSyncEnabled;
    setDrawSyncEnabled(nextEnabled);

    if (nextEnabled) {
      flushQueuedStrokes();
    }
  }, [drawSyncEnabled, flushQueuedStrokes, role]);

  const toggleSyncLock = useCallback(() => {
    if (role !== "dm" || !snapshot) {
      return;
    }

    const nextSyncLock = !snapshot.session.syncLock;

    setSnapshot({
      ...snapshot,
      session: {
        ...snapshot.session,
        syncLock: nextSyncLock
      }
    });

    sendDmMessage({
      type: "dm.syncLock.set",
      payload: {
        syncLock: nextSyncLock,
        camera: nextSyncLock ? camera : undefined,
        cameraSync: nextSyncLock ? buildCameraSyncMeta(camera, viewportSize) : undefined
      }
    });
  }, [camera, role, sendDmMessage, snapshot, viewportSize]);

  const handleUploadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const [selectedFile] = event.target.files ?? [];
      if (!selectedFile) {
        return;
      }

      setUploading(true);
      setError(null);

      try {
        await uploadMap(selectedFile);
        const updatedSnapshot = await fetchSession();
        setSnapshot(updatedSnapshot);
        setCamera(updatedSnapshot.session.camera);
      } catch (uploadError: unknown) {
        const message = uploadError instanceof Error ? uploadError.message : "Map upload failed";
        setError(message);
      } finally {
        setUploading(false);
        event.target.value = "";
      }
    },
    []
  );

  const handlePdfPageChange = useCallback(async (nextPage: number) => {
    try {
      const updated = await patchSession({ pdfPage: nextPage });
      setSnapshot(updated);
    } catch (pageError: unknown) {
      const message = pageError instanceof Error ? pageError.message : "Failed to change page";
      setError(message);
    }
  }, []);

  const sendUndo = useCallback(() => {
    sendDmMessage({ type: "dm.history.undo", payload: {} });
  }, [sendDmMessage]);

  const sendRedo = useCallback(() => {
    sendDmMessage({ type: "dm.history.redo", payload: {} });
  }, [sendDmMessage]);

  const fullMapStroke = useCallback(
    (mode: "reveal" | "refog"): FogStroke | null => {
      if (!loadedMap) {
        return null;
      }

      return {
        brush: {
          shape: "square",
          sizePx: 1,
          hardness: 1,
          mode
        },
        pointsWorld: [],
        rectangle: {
          x: 0,
          y: 0,
          width: loadedMap.width,
          height: loadedMap.height,
          roundness: 0,
          softness: 0,
          mode
        },
        timestamp: Date.now(),
        strokeGroupId: `full-map-${mode}-${Date.now()}`
      };
    },
    [loadedMap]
  );

  const handleRevealAll = useCallback(() => {
    const stroke = fullMapStroke("reveal");
    if (!stroke) {
      return;
    }

    if (!window.confirm("Reveal the whole map for players?")) {
      return;
    }

    handleStroke(stroke);
  }, [fullMapStroke, handleStroke]);

  const handleRefogAll = useCallback(() => {
    const stroke = fullMapStroke("refog");
    if (!stroke) {
      return;
    }

    if (!window.confirm("Re-fog the whole map for players?")) {
      return;
    }

    handleStroke(stroke);
  }, [fullMapStroke, handleStroke]);

  const activeMap = snapshot?.activeMap ?? null;
  const canEdit = role === "dm";
  const appShellClassName = canEdit ? "app-shell dm-mode" : "app-shell player-mode";
  const viewportShellClassName = canEdit
    ? "viewport-shell dm-viewport-shell"
    : "viewport-shell player-viewport-shell";

  const dmFrameStyle = useMemo<CSSProperties | undefined>(() => {
    if (!canEdit) {
      return undefined;
    }

    const targetAspect = windowSize.width / windowSize.height;
    const fitted = fitAspect(dmShellSize, targetAspect);
    return {
      width: `${fitted.width}px`,
      height: `${fitted.height}px`
    };
  }, [canEdit, dmShellSize, windowSize]);

  const playerFrameStyle = useMemo<CSSProperties | undefined>(() => {
    if (canEdit) {
      return undefined;
    }

    const cameraSync = snapshot?.session.cameraSync;
    if (!cameraSync || cameraSync.viewportWidth <= 0 || cameraSync.viewportHeight <= 0) {
      return undefined;
    }

    const fitted = fitAspect(windowSize, cameraSync.viewportWidth / cameraSync.viewportHeight);
    return {
      width: `${fitted.width}px`,
      height: `${fitted.height}px`
    };
  }, [canEdit, snapshot?.session.cameraSync, windowSize]);

  return (
    <div className={appShellClassName}>
      {canEdit && (
        <aside className="dm-panel">
          <h1>DM Controls</h1>
          <div className="status-row">
            <span>Connection: {connected ? "Connected" : "Reconnecting"}</span>
          </div>

          {error ? <p className="error-text">{error}</p> : null}

          <section className="panel-group">
            <label className="file-upload">
              <span>{uploading ? "Uploading..." : "Load PNG / PDF"}</span>
              <input type="file" accept=".png,.jpg,.jpeg,.pdf" onChange={handleUploadFile} disabled={uploading} />
            </label>

            {activeMap ? <p className="map-name">Map: {activeMap.name}</p> : <p>No active map</p>}

            {activeMap?.kind === "pdf" ? (
              <label>
                PDF page
                <input
                  type="number"
                  min={1}
                  max={activeMap.pdfPageCount}
                  value={snapshot?.session.pdfPage ?? 1}
                  onChange={(event) => handlePdfPageChange(Number(event.target.value))}
                />
              </label>
            ) : null}
          </section>

          <section className="panel-group">
            <h2>Tool</h2>
            <div className="tool-toggle">
              <button
                type="button"
                className={dmTool === "brush" ? "active-tool" : undefined}
                onClick={() => setDmTool("brush")}
              >
                Brush
              </button>
              <button
                type="button"
                className={dmTool === "pan" ? "active-tool" : undefined}
                onClick={() => setDmTool("pan")}
              >
                Pan
              </button>
              <button
                type="button"
                className={dmTool === "rect" ? "active-tool" : undefined}
                onClick={() => setDmTool("rect")}
              >
                Rectangle
              </button>
            </div>
          </section>

          <section className="panel-group">
            <h2>Brush</h2>
            <label>
              Shape
              <select
                value={brush.shape}
                disabled={dmTool !== "brush"}
                onChange={(event) => setBrush((current) => ({ ...current, shape: event.target.value as BrushConfig["shape"] }))}
              >
                <option value="round">Round</option>
                <option value="square">Square</option>
              </select>
            </label>

            <label>
              Mode
              <select
                value={brush.mode}
                disabled={dmTool !== "brush"}
                onChange={(event) => setBrush((current) => ({ ...current, mode: event.target.value as BrushConfig["mode"] }))}
              >
                <option value="reveal">Reveal</option>
                <option value="refog">Re-fog</option>
              </select>
            </label>

            <label>
              Size: {Math.round(brush.sizePx)}px
              <input
                type="range"
                min={8}
                max={420}
                value={brush.sizePx}
                disabled={dmTool !== "brush"}
                onChange={(event) => setBrush((current) => ({ ...current, sizePx: Number(event.target.value) }))}
              />
            </label>

            <label>
              Hardness: {brush.hardness.toFixed(2)}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={brush.hardness}
                disabled={dmTool !== "brush"}
                onChange={(event) => setBrush((current) => ({ ...current, hardness: Number(event.target.value) }))}
              />
            </label>
          </section>

          <section className="panel-group">
            <h2>Rectangle</h2>
            <label>
              Mode
              <select
                value={rectangleTool.mode}
                disabled={dmTool !== "rect"}
                onChange={(event) =>
                  setRectangleTool((current) => ({
                    ...current,
                    mode: event.target.value as BrushConfig["mode"]
                  }))
                }
              >
                <option value="reveal">Reveal</option>
                <option value="refog">Re-fog</option>
              </select>
            </label>

            <label>
              Roundness: {Math.round(rectangleTool.roundness * 100)}%
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={rectangleTool.roundness}
                disabled={dmTool !== "rect"}
                onChange={(event) =>
                  setRectangleTool((current) => ({
                    ...current,
                    roundness: Number(event.target.value)
                  }))
                }
              />
            </label>

            <label>
              Softness: {rectangleTool.softness.toFixed(2)}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={rectangleTool.softness}
                disabled={dmTool !== "rect"}
                onChange={(event) =>
                  setRectangleTool((current) => ({
                    ...current,
                    softness: Number(event.target.value)
                  }))
                }
              />
            </label>
          </section>

          <section className="panel-group row-actions">
            <button type="button" onClick={toggleSyncLock}>
              Camera Sync: {snapshot?.session.syncLock ? "Locked" : "Unlocked"}
            </button>
            <button type="button" onClick={toggleDrawSync}>
              Draw Sync: {drawSyncEnabled ? "Live" : `Paused (${queuedStrokeCount})`}
            </button>
            <button type="button" onClick={resetViewToMap} disabled={!loadedMap}>
              Reset View
            </button>
            <button type="button" onClick={sendUndo} disabled={!drawSyncEnabled || queuedStrokeCount > 0}>
              Undo
            </button>
            <button type="button" onClick={sendRedo} disabled={!drawSyncEnabled || queuedStrokeCount > 0}>
              Redo
            </button>
            <button type="button" onClick={handleRevealAll}>
              Reveal All
            </button>
            <button type="button" onClick={handleRefogAll}>
              Re-fog All
            </button>
          </section>

          {bootstrap ? (
            <section className="panel-group">
              <h2>Player Join</h2>
              <a href={bootstrap.playerUrl} target="_blank" rel="noreferrer">
                {bootstrap.playerUrl}
              </a>
            </section>
          ) : null}
        </aside>
      )}

      <main ref={viewportShellRef} className={viewportShellClassName}>
        <div
          className={canEdit ? "viewport-frame dm-frame" : "viewport-frame player-frame"}
          style={canEdit ? dmFrameStyle : playerFrameStyle}
        >
          <MapViewport
            mode={role}
            mapSurface={loadedMap}
            fog={localFog}
            camera={camera}
            brush={brush}
            activeTool={canEdit ? dmTool : "brush"}
            rectangleTool={rectangleTool}
            onCameraChange={canEdit ? handleCameraChange : undefined}
            onStroke={canEdit ? handleStroke : undefined}
            onViewportChange={(size) => setViewportSize(size)}
          />
        </div>
        {canEdit ? (
          <div className="zoom-overlay">
            <button type="button" onClick={resetViewToMap} disabled={!loadedMap}>
              Fit
            </button>
            <button type="button" onClick={() => setZoomLevel(camera.zoom + 0.2)}>
              +
            </button>
            <input
              aria-label="Zoom"
              type="range"
              min={0.15}
              max={8}
              step={0.01}
              value={camera.zoom}
              onChange={(event) => setZoomLevel(Number(event.target.value))}
            />
            <button type="button" onClick={() => setZoomLevel(camera.zoom - 0.2)}>
              -
            </button>
            <span>{camera.zoom.toFixed(2)}x</span>
          </div>
        ) : null}
      </main>
    </div>
  );
}
