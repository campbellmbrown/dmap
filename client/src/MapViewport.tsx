import {
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";

import type { BrushConfig, CameraState, FogStroke } from "@shared/types";
import type { LoadedMapSurface } from "./mapLoader";
import { fogToImageData, type LocalFogState } from "./fogClient";

interface MapViewportProps {
  mode: "dm" | "player";
  mapSurface: LoadedMapSurface | null;
  fog: LocalFogState | null;
  camera: CameraState;
  brush: BrushConfig;
  onCameraChange?: (camera: CameraState) => void;
  onStroke?: (stroke: FogStroke) => void;
}

interface DragState {
  pointerId: number;
  type: "pan" | "paint";
  startX: number;
  startY: number;
  startCamera: CameraState;
  points: Array<{ x: number; y: number }>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function MapViewport(props: MapViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

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
    };

    render();

    const observer = new ResizeObserver(() => {
      render();
    });

    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, [props.camera, props.fog, props.mapSurface, fogCanvas]);

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

    const isPanStart = event.button === 1 || event.button === 2;
    const isPaintStart = event.button === 0;

    if (!isPanStart && !isPaintStart) {
      return;
    }

    const worldPoint = toWorldPoint(event.clientX, event.clientY);
    if (!worldPoint && isPaintStart) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      type: isPanStart ? "pan" : "paint",
      startX: event.clientX,
      startY: event.clientY,
      startCamera: props.camera,
      points: worldPoint ? [worldPoint] : []
    };

    (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
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
      });
      return;
    }

    const worldPoint = toWorldPoint(event.clientX, event.clientY);
    if (!worldPoint) {
      return;
    }

    const points = dragState.points;
    const lastPoint = points[points.length - 1];
    if (!lastPoint) {
      points.push(worldPoint);
      return;
    }

    const dx = worldPoint.x - lastPoint.x;
    const dy = worldPoint.y - lastPoint.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance >= 1) {
      points.push(worldPoint);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (dragState.type === "paint" && dragState.points.length > 0 && props.onStroke) {
      props.onStroke({
        brush: props.brush,
        pointsWorld: dragState.points,
        timestamp: Date.now()
      });
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
    });
  };

  return (
    <canvas
      ref={canvasRef}
      className="map-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}
