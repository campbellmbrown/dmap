import { applyStrokeToMask, decodeMask, replayStrokes } from "@shared/fogEngine";
import type { FogState, FogStroke } from "@shared/types";

export interface LocalFogState {
  worldWidth: number;
  worldHeight: number;
  maskWidth: number;
  maskHeight: number;
  mask: Uint8ClampedArray;
  historyIndex: number;
  strokeCount: number;
}

export function fromServerFogState(fogState: FogState): LocalFogState {
  return {
    worldWidth: fogState.worldWidth,
    worldHeight: fogState.worldHeight,
    maskWidth: fogState.maskWidth,
    maskHeight: fogState.maskHeight,
    mask: decodeMask(fogState.maskBase64),
    historyIndex: fogState.historyIndex,
    strokeCount: fogState.strokeCount
  };
}

export function applyStrokeToLocalFog(fog: LocalFogState, stroke: FogStroke): void {
  applyStrokeToMask(
    fog.mask,
    {
      worldWidth: fog.worldWidth,
      worldHeight: fog.worldHeight,
      maskWidth: fog.maskWidth,
      maskHeight: fog.maskHeight
    },
    stroke
  );

  fog.historyIndex += 1;
  fog.strokeCount += 1;
}

export function rebuildLocalFogFromStrokes(
  fog: LocalFogState,
  strokes: FogStroke[],
  historyIndex: number
): LocalFogState {
  return {
    ...fog,
    mask: replayStrokes(
      {
        worldWidth: fog.worldWidth,
        worldHeight: fog.worldHeight,
        maskWidth: fog.maskWidth,
        maskHeight: fog.maskHeight
      },
      strokes,
      historyIndex
    ),
    historyIndex,
    strokeCount: strokes.length
  };
}

export function fogToImageData(fog: LocalFogState, dmView: boolean): ImageData {
  const pixels = new Uint8ClampedArray(fog.maskWidth * fog.maskHeight * 4);
  const alphaScale = dmView ? 0.6 : 1;

  for (let index = 0; index < fog.mask.length; index += 1) {
    const value = fog.mask[index];
    const pixelOffset = index * 4;
    pixels[pixelOffset] = 0;
    pixels[pixelOffset + 1] = 0;
    pixels[pixelOffset + 2] = 0;
    pixels[pixelOffset + 3] = Math.round(value * alphaScale);
  }

  return new ImageData(pixels, fog.maskWidth, fog.maskHeight);
}
