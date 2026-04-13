import type { BrushConfig, FogStroke } from "./types";

const MAX_FOG_VALUE = 255;
const DEFAULT_MAX_MASK_SIDE = 2048;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface AdaptiveMaskSize {
  maskWidth: number;
  maskHeight: number;
}

export interface FogRasterMeta {
  worldWidth: number;
  worldHeight: number;
  maskWidth: number;
  maskHeight: number;
}

export function getAdaptiveMaskSize(
  worldWidth: number,
  worldHeight: number,
  maxSide: number = DEFAULT_MAX_MASK_SIDE
): AdaptiveMaskSize {
  const longestSide = Math.max(worldWidth, worldHeight);
  const scale = longestSide > maxSide ? maxSide / longestSide : 1;

  return {
    maskWidth: Math.max(1, Math.round(worldWidth * scale)),
    maskHeight: Math.max(1, Math.round(worldHeight * scale))
  };
}

export function createFullFogMask(maskWidth: number, maskHeight: number): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(maskWidth * maskHeight);
  mask.fill(MAX_FOG_VALUE);
  return mask;
}

function brushCoverage(brush: BrushConfig, normalizedDistance: number): number {
  if (normalizedDistance > 1) {
    return 0;
  }

  const hardness = clamp(brush.hardness, 0, 1);
  if (hardness >= 0.999) {
    return 1;
  }

  const inner = hardness;
  if (normalizedDistance <= inner) {
    return 1;
  }

  const range = 1 - inner;
  if (range <= 0) {
    return 1;
  }

  return 1 - (normalizedDistance - inner) / range;
}

function applyCoverage(currentValue: number, mode: BrushConfig["mode"], coverage: number): number {
  if (coverage <= 0) {
    return currentValue;
  }

  if (mode === "reveal") {
    return Math.round(currentValue * (1 - coverage));
  }

  return Math.round(currentValue + (MAX_FOG_VALUE - currentValue) * coverage);
}

function drawDab(
  mask: Uint8ClampedArray,
  meta: FogRasterMeta,
  brush: BrushConfig,
  centerMaskX: number,
  centerMaskY: number
): void {
  const scaleX = meta.maskWidth / meta.worldWidth;
  const scaleY = meta.maskHeight / meta.worldHeight;
  const brushRadius = Math.max(1, (brush.sizePx * (scaleX + scaleY)) / 4);

  const minX = Math.max(0, Math.floor(centerMaskX - brushRadius - 1));
  const maxX = Math.min(meta.maskWidth - 1, Math.ceil(centerMaskX + brushRadius + 1));
  const minY = Math.max(0, Math.floor(centerMaskY - brushRadius - 1));
  const maxY = Math.min(meta.maskHeight - 1, Math.ceil(centerMaskY + brushRadius + 1));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - centerMaskX;
      const dy = y + 0.5 - centerMaskY;

      const normalizedDistance =
        brush.shape === "round"
          ? Math.sqrt(dx * dx + dy * dy) / brushRadius
          : Math.max(Math.abs(dx), Math.abs(dy)) / brushRadius;

      const coverage = brushCoverage(brush, normalizedDistance);
      if (coverage <= 0) {
        continue;
      }

      const index = y * meta.maskWidth + x;
      mask[index] = applyCoverage(mask[index], brush.mode, coverage);
    }
  }
}

function worldToMaskX(meta: FogRasterMeta, worldX: number): number {
  return (worldX / meta.worldWidth) * meta.maskWidth;
}

function worldToMaskY(meta: FogRasterMeta, worldY: number): number {
  return (worldY / meta.worldHeight) * meta.maskHeight;
}

export function applyStrokeToMask(mask: Uint8ClampedArray, meta: FogRasterMeta, stroke: FogStroke): void {
  if (stroke.pointsWorld.length === 0) {
    return;
  }

  const { pointsWorld, brush } = stroke;
  const minStep = Math.max(1, brush.sizePx * 0.25);

  for (let pointIndex = 0; pointIndex < pointsWorld.length; pointIndex += 1) {
    const point = pointsWorld[pointIndex];
    const pointX = worldToMaskX(meta, point.x);
    const pointY = worldToMaskY(meta, point.y);

    if (pointIndex === 0) {
      drawDab(mask, meta, brush, pointX, pointY);
      continue;
    }

    const previous = pointsWorld[pointIndex - 1];
    const previousX = worldToMaskX(meta, previous.x);
    const previousY = worldToMaskY(meta, previous.y);

    const dx = pointX - previousX;
    const dy = pointY - previousY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(distance / minStep));

    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      drawDab(mask, meta, brush, previousX + dx * t, previousY + dy * t);
    }
  }
}

export function replayStrokes(
  meta: FogRasterMeta,
  strokes: FogStroke[],
  historyIndex: number
): Uint8ClampedArray {
  const mask = createFullFogMask(meta.maskWidth, meta.maskHeight);
  const appliedCount = clamp(historyIndex, 0, strokes.length);

  for (let i = 0; i < appliedCount; i += 1) {
    applyStrokeToMask(mask, meta, strokes[i]);
  }

  return mask;
}

export function encodeMask(mask: Uint8ClampedArray): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(mask).toString("base64");
  }

  let binary = "";
  for (let i = 0; i < mask.length; i += 1) {
    binary += String.fromCharCode(mask[i]);
  }

  return btoa(binary);
}

export function decodeMask(maskBase64: string): Uint8ClampedArray {
  if (typeof Buffer !== "undefined") {
    return new Uint8ClampedArray(Buffer.from(maskBase64, "base64"));
  }

  const binary = atob(maskBase64);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}
