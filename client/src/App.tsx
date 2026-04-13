import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import type {
  BootstrapResponse,
  BrushConfig,
  CameraState,
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

function cloneFogState(fog: LocalFogState): LocalFogState {
  return {
    ...fog,
    mask: new Uint8ClampedArray(fog.mask)
  };
}

function roleFromPath(pathname: string): ClientRole {
  if (pathname.startsWith("/player")) {
    return "player";
  }

  return "dm";
}

function roomCodeFromUrl(): string {
  return new URLSearchParams(window.location.search).get("room") ?? "";
}

export function App() {
  const role = useMemo(() => roleFromPath(window.location.pathname), []);
  const [roomCode, setRoomCode] = useState(() => roomCodeFromUrl());
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [loadedMap, setLoadedMap] = useState<LoadedMapSurface | null>(null);
  const [localFog, setLocalFog] = useState<LocalFogState | null>(null);
  const [camera, setCamera] = useState<CameraState>({ x: 0, y: 0, zoom: 1 });
  const [brush, setBrush] = useState<BrushConfig>(DEFAULT_BRUSH);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const socketRef = useRef<SocketClient | null>(null);

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
        if (sessionSnapshot.session.syncLock || role === "player") {
          setCamera(sessionSnapshot.session.camera);
        }
      })
      .catch((sessionError: unknown) => {
        const message = sessionError instanceof Error ? sessionError.message : "Failed to fetch session";
        setError(message);
      });
  }, [role]);

  useEffect(() => {
    if (!snapshot?.session.fogState) {
      setLocalFog(null);
      return;
    }

    setLocalFog(fromServerFogState(snapshot.session.fogState));
  }, [snapshot?.session.fogState]);

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
      switch (message.type) {
        case "session.snapshot": {
          setSnapshot(message.payload);

          if (role === "dm") {
            if (message.payload.session.syncLock) {
              setCamera(message.payload.session.camera);
            }
          } else {
            setCamera((current) => (message.payload.session.syncLock ? message.payload.session.camera : current));
          }

          break;
        }

        case "dm.camera.set": {
          if (role === "player") {
            setCamera(message.payload.camera);
          } else if (snapshot?.session.syncLock) {
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
    [role, snapshot?.session.syncLock]
  );

  useEffect(() => {
    if (role === "player" && !roomCode) {
      return;
    }

    const socket = connectSocket({
      role,
      roomCode,
      onStatus: setConnected,
      onMessage: handleSocketMessage,
      onError: setError
    });

    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [role, roomCode, handleSocketMessage]);

  const sendDmMessage = useCallback((payload: Parameters<SocketClient["send"]>[0]) => {
    socketRef.current?.send(payload);
  }, []);

  const handleCameraChange = useCallback(
    (nextCamera: CameraState) => {
      setCamera(nextCamera);

      if (role !== "dm") {
        return;
      }

      if (!snapshot?.session.syncLock) {
        return;
      }

      sendDmMessage({
        type: "dm.camera.set",
        payload: { camera: nextCamera }
      });
    },
    [role, sendDmMessage, snapshot?.session.syncLock]
  );

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

      sendDmMessage({
        type: "dm.fog.stroke",
        payload: { stroke }
      });
    },
    [applyLocalStroke, role, sendDmMessage]
  );

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
        camera: nextSyncLock ? camera : undefined
      }
    });
  }, [camera, role, sendDmMessage, snapshot]);

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

      const size = Math.max(loadedMap.width, loadedMap.height) * 2;

      return {
        brush: {
          shape: "square",
          sizePx: size,
          hardness: 1,
          mode
        },
        pointsWorld: [
          {
            x: loadedMap.width / 2,
            y: loadedMap.height / 2
          }
        ],
        timestamp: Date.now()
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

  if (role === "player" && !roomCode) {
    return (
      <main className="join-screen">
        <h1>Join DnD Map Session</h1>
        <p>Enter the room code shown on the DM screen.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const input = new FormData(event.currentTarget).get("roomCode")?.toString() ?? "";
            const trimmed = input.trim().toUpperCase();
            setRoomCode(trimmed);
            const url = new URL(window.location.href);
            url.searchParams.set("room", trimmed);
            window.history.replaceState({}, "", url.toString());
          }}
        >
          <input name="roomCode" placeholder="Room code" maxLength={10} autoComplete="off" />
          <button type="submit">Join</button>
        </form>
      </main>
    );
  }

  const activeMap = snapshot?.activeMap ?? null;
  const canEdit = role === "dm";

  return (
    <div className="app-shell">
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
            <h2>Brush</h2>
            <label>
              Shape
              <select
                value={brush.shape}
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
                onChange={(event) => setBrush((current) => ({ ...current, hardness: Number(event.target.value) }))}
              />
            </label>
          </section>

          <section className="panel-group row-actions">
            <button type="button" onClick={toggleSyncLock}>
              Camera Sync: {snapshot?.session.syncLock ? "Locked" : "Unlocked"}
            </button>
            <button type="button" onClick={sendUndo}>
              Undo
            </button>
            <button type="button" onClick={sendRedo}>
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
              <p>Room code: {bootstrap.roomCode ?? "<hidden>"}</p>
              <a href={bootstrap.playerUrl} target="_blank" rel="noreferrer">
                {bootstrap.playerUrl}
              </a>
              <img src={bootstrap.qrDataUrl} alt="Player QR code" className="qr-image" />
            </section>
          ) : null}
        </aside>
      )}

      <main className="viewport-shell">
        <MapViewport
          mode={role}
          mapSurface={loadedMap}
          fog={localFog}
          camera={camera}
          brush={brush}
          onCameraChange={canEdit ? handleCameraChange : undefined}
          onStroke={canEdit ? handleStroke : undefined}
        />
      </main>
    </div>
  );
}
