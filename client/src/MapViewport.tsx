import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";

import type { BrushConfig, CameraState, FogStroke, Point } from "@shared/types";
import type { LoadedMapSurface } from "./mapLoader";
import { fogToImageData, type LocalFogState } from "./fogClient";

interface MapViewportProps {
  mode: "dm" | "player";
  mapSurface: LoadedMapSurface | null;
  fog: LocalFogState | null;
  camera: CameraState;
  brush: BrushConfig;
  activeTool?: "brush" | "pan" | "rect";
  rectangleTool?: {
    mode: BrushConfig["mode"];
    roundness: number;
    softness: number;
  };
  onCameraChange?: (camera: CameraState, viewport: { width: number; height: number }) => void;
  onStroke?: (stroke: FogStroke) => void;
  onViewportChange?: (size: { width: number; height: number }) => void;
}

interface DragState {
  pointerId: number;
  type: "pan" | "paint" | "rect";
  startX: number;
  startY: number;
  startCamera: CameraState;
  lastPaintPoint: { x: number; y: number } | null;
  strokeGroupId: string | null;
  rectStartWorld: Point | null;
  rectCurrentWorld: Point | null;
}

interface RectPreview {
  start: Point;
  end: Point;
}

interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizedRect(start: Point, end: Point): NormalizedRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.max(0, Math.abs(end.x - start.x)),
    height: Math.max(0, Math.abs(end.y - start.y))
  };
}

function traceRoundedRect(
  context: CanvasRenderingContext2D,
  rect: NormalizedRect,
  cornerRadius: number
): void {
  const radius = clamp(cornerRadius, 0, Math.min(rect.width, rect.height) / 2);
  const x = rect.x;
  const y = rect.y;
  const right = x + rect.width;
  const bottom = y + rect.height;

  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(right - radius, y);
  context.quadraticCurveTo(right, y, right, y + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(x + radius, bottom);
  context.quadraticCurveTo(x, bottom, x, bottom - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

export function MapViewport(props: MapViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [hoverWorldPoint, setHoverWorldPoint] = useState<{ x: number; y: number } | null>(null);
  const [rectanglePreview, setRectanglePreview] = useState<RectPreview | null>(null);

  const createStrokeGroupId = (): string => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  };

  const currentViewportSize = (): { width: number; height: number } => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return {
      width: Math.max(1, rect?.width ?? window.innerWidth),
      height: Math.max(1, rect?.height ?? window.innerHeight)
    };
  };

  const activeTool = props.activeTool ?? "brush";
  const isBrushToolActive = props.mode === "dm" && activeTool === "brush";
  const isRectToolActive = props.mode === "dm" && activeTool === "rect";

  const fogCanvas = useMemo(() => {
    if (!props.fog) {
      return null;
    }

    const offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = props.fog.maskWidth;
    offscreenCanvas.height = props.fog.maskHeight;

    const context = offscreenCanvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.putImageData(fogToImageData(props.fog, props.mode === "dm"), 0, 0);
    return offscreenCanvas;
  }, [props.fog, props.mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const render = (): void => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      const targetWidth = Math.max(1, Math.floor(rect.width * dpr));
      const targetHeight = Math.max(1, Math.floor(rect.height * dpr));

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      context.fillStyle = "#111";
      context.fillRect(0, 0, rect.width, rect.height);

      if (!props.mapSurface) {
        context.fillStyle = "#999";
        context.font = "16px sans-serif";
        context.fillText("Load a map to begin", 16, 28);
        return;
      }

      const { camera } = props;

      context.save();
      context.translate(-camera.x * camera.zoom, -camera.y * camera.zoom);
      context.scale(camera.zoom, camera.zoom);
      context.drawImage(props.mapSurface.canvas, 0, 0);

      if (fogCanvas && props.fog) {
        context.drawImage(
          fogCanvas,
          0,
          0,
          props.fog.maskWidth,
          props.fog.maskHeight,
          0,
          0,
          props.fog.worldWidth,
          props.fog.worldHeight
        );
      }

      context.restore();

      if (isBrushToolActive && props.mapSurface && hoverWorldPoint) {
        const radius = props.brush.sizePx / 2;

        context.save();
        context.translate(-camera.x * camera.zoom, -camera.y * camera.zoom);
        context.scale(camera.zoom, camera.zoom);

        context.lineWidth = Math.max(1, 1.5 / camera.zoom);
        context.strokeStyle = "rgba(255, 255, 255, 0.95)";
        context.fillStyle = "rgba(255, 255, 255, 0.1)";

        if (props.brush.shape === "round") {
          context.beginPath();
          context.arc(hoverWorldPoint.x, hoverWorldPoint.y, radius, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        } else {
          context.fillRect(hoverWorldPoint.x - radius, hoverWorldPoint.y - radius, radius * 2, radius * 2);
          context.strokeRect(hoverWorldPoint.x - radius, hoverWorldPoint.y - radius, radius * 2, radius * 2);
        }

        context.restore();
      }

      if (isRectToolActive && rectanglePreview) {
        const rectPreview = normalizedRect(rectanglePreview.start, rectanglePreview.end);
        if (rectPreview.width > 0 && rectPreview.height > 0) {
          const roundness = clamp(props.rectangleTool?.roundness ?? 0, 0, 1);
          const cornerRadius = (Math.min(rectPreview.width, rectPreview.height) / 2) * roundness;

          context.save();
          context.translate(-camera.x * camera.zoom, -camera.y * camera.zoom);
          context.scale(camera.zoom, camera.zoom);
          context.lineWidth = Math.max(1, 1.5 / camera.zoom);
          context.strokeStyle = "rgba(255, 255, 255, 0.95)";
          context.fillStyle = "rgba(255, 255, 255, 0.12)";
          traceRoundedRect(context, rectPreview, cornerRadius);
          context.fill();
          context.stroke();
          context.restore();
        }
      }
    };

    render();

    const observer = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      props.onViewportChange?.({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height)
      });
      render();
    });

    observer.observe(canvas);
    const initialRect = canvas.getBoundingClientRect();
    props.onViewportChange?.({
      width: Math.max(1, initialRect.width),
      height: Math.max(1, initialRect.height)
    });

    return () => {
      observer.disconnect();
    };
  }, [
    props.camera,
    props.fog,
    props.mapSurface,
    isBrushToolActive,
    isRectToolActive,
    props.brush.shape,
    props.brush.sizePx,
    props.rectangleTool?.roundness,
    props.onViewportChange,
    fogCanvas,
    hoverWorldPoint,
    rectanglePreview
  ]);

  const toWorldPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas || !props.mapSurface) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    const worldX = props.camera.x + localX / props.camera.zoom;
    const worldY = props.camera.y + localY / props.camera.zoom;

    return {
      x: clamp(worldX, 0, props.mapSurface.width),
      y: clamp(worldY, 0, props.mapSurface.height)
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (props.mode !== "dm" || !props.mapSurface) {
      return;
    }

    const isPanTool = activeTool === "pan";
    const isRectTool = activeTool === "rect";
    const isPanStart = isPanTool
      ? event.button === 0 || event.button === 1 || event.button === 2
      : event.button === 1 || event.button === 2;
    const isPaintStart = activeTool === "brush" && event.button === 0;
    const isRectStart = isRectTool && event.button === 0;

    if (!isPanStart && !isPaintStart && !isRectStart) {
      return;
    }

    const worldPoint = toWorldPoint(event.clientX, event.clientY);
    if (!worldPoint && (isPaintStart || isRectStart)) {
      return;
    }
    setHoverWorldPoint(worldPoint);

    const strokeGroupId = isPaintStart ? createStrokeGroupId() : null;

    if (isPaintStart && worldPoint && props.onStroke) {
      props.onStroke({
        brush: props.brush,
        pointsWorld: [worldPoint],
        timestamp: Date.now(),
        strokeGroupId: strokeGroupId ?? undefined
      });
    }

    if (isRectStart && worldPoint) {
      setRectanglePreview({
        start: worldPoint,
        end: worldPoint
      });
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      type: isPanStart ? "pan" : isRectStart ? "rect" : "paint",
      startX: event.clientX,
      startY: event.clientY,
      startCamera: props.camera,
      lastPaintPoint: worldPoint ?? null,
      strokeGroupId,
      rectStartWorld: isRectStart ? worldPoint : null,
      rectCurrentWorld: isRectStart ? worldPoint : null
    };

    (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (props.mode === "dm") {
      const hoverPoint = toWorldPoint(event.clientX, event.clientY);
      setHoverWorldPoint(hoverPoint);
    }

    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (dragState.type === "pan") {
      if (!props.onCameraChange) {
        return;
      }

      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;

      props.onCameraChange({
        x: dragState.startCamera.x - dx / props.camera.zoom,
        y: dragState.startCamera.y - dy / props.camera.zoom,
        zoom: props.camera.zoom
      }, currentViewportSize());
      return;
    }

    if (dragState.type === "rect") {
      const worldPoint = toWorldPoint(event.clientX, event.clientY);
      if (!worldPoint || !dragState.rectStartWorld) {
        return;
      }

      dragState.rectCurrentWorld = worldPoint;
      setRectanglePreview({
        start: dragState.rectStartWorld,
        end: worldPoint
      });
      return;
    }

    const emitPaintPoint = (worldPoint: Point): void => {
      const lastPoint = dragState.lastPaintPoint;
      if (!lastPoint) {
        dragState.lastPaintPoint = worldPoint;
        if (props.onStroke) {
          props.onStroke({
            brush: props.brush,
            pointsWorld: [worldPoint],
            timestamp: Date.now(),
            strokeGroupId: dragState.strokeGroupId ?? undefined
          });
        }
        return;
      }

      const dx = worldPoint.x - lastPoint.x;
      const dy = worldPoint.y - lastPoint.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < 0.25) {
        return;
      }

      dragState.lastPaintPoint = worldPoint;

      if (props.onStroke) {
        props.onStroke({
          brush: props.brush,
          pointsWorld: [lastPoint, worldPoint],
          timestamp: Date.now(),
          strokeGroupId: dragState.strokeGroupId ?? undefined
        });
      }
    };

    const nativePointerEvent = event.nativeEvent as PointerEvent;
    const coalescedEvents =
      typeof nativePointerEvent.getCoalescedEvents === "function"
        ? nativePointerEvent.getCoalescedEvents()
        : [nativePointerEvent];

    for (const pointerSample of coalescedEvents) {
      const worldPoint = toWorldPoint(pointerSample.clientX, pointerSample.clientY);
      if (!worldPoint) {
        continue;
      }
      emitPaintPoint(worldPoint);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (dragState.type === "rect" && props.onStroke && dragState.rectStartWorld && dragState.rectCurrentWorld) {
      const rect = normalizedRect(dragState.rectStartWorld, dragState.rectCurrentWorld);
      if (rect.width >= 1 && rect.height >= 1) {
        props.onStroke({
          brush: {
            ...props.brush,
            mode: props.rectangleTool?.mode ?? props.brush.mode
          },
          pointsWorld: [],
          timestamp: Date.now(),
          rectangle: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            roundness: clamp(props.rectangleTool?.roundness ?? 0, 0, 1),
            softness: clamp(props.rectangleTool?.softness ?? 0, 0, 1),
            mode: props.rectangleTool?.mode ?? props.brush.mode
          }
        });
      }
      setRectanglePreview(null);
    }

    dragStateRef.current = null;
    (event.target as HTMLCanvasElement).releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>): void => {
    if (props.mode !== "dm" || !props.onCameraChange || !props.mapSurface) {
      return;
    }

    event.preventDefault();

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;

    const currentZoom = props.camera.zoom;
    const zoomDelta = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clamp(currentZoom * zoomDelta, 0.15, 8);

    const worldX = props.camera.x + pointerX / currentZoom;
    const worldY = props.camera.y + pointerY / currentZoom;

    props.onCameraChange({
      x: worldX - pointerX / nextZoom,
      y: worldY - pointerY / nextZoom,
      zoom: nextZoom
    }, currentViewportSize());
  };

  const cursorClassName =
    props.mode === "dm" && activeTool === "pan" ? "pan-mode" : props.mode === "dm" && activeTool === "rect" ? "rect-mode" : "brush-mode";

  return (
    <canvas
      ref={canvasRef}
      className={`map-canvas ${cursorClassName}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        if (!dragStateRef.current) {
          setHoverWorldPoint(null);
        }
      }}
      onWheel={onWheel}
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}
