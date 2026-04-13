import { describe, expect, it } from "vitest";

import { applyStrokeToMask, createFullFogMask, replayStrokes } from "../../shared/src/fogEngine";
import type { FogStroke } from "../../shared/src/types";

const meta = {
  worldWidth: 200,
  worldHeight: 200,
  maskWidth: 200,
  maskHeight: 200
};

function getPixel(mask: Uint8ClampedArray, x: number, y: number): number {
  return mask[y * meta.maskWidth + x];
}

function buildStroke(overrides: Partial<FogStroke>): FogStroke {
  return {
    brush: {
      shape: "round",
      sizePx: 40,
      hardness: 1,
      mode: "reveal"
    },
    pointsWorld: [{ x: 100, y: 100 }],
    timestamp: 1,
    ...overrides
  };
}

describe("fogEngine", () => {
  it("applies hard round brush with sharp center reveal", () => {
    const mask = createFullFogMask(meta.maskWidth, meta.maskHeight);
    applyStrokeToMask(mask, meta, buildStroke({}));

    expect(getPixel(mask, 100, 100)).toBe(0);
    expect(getPixel(mask, 10, 10)).toBe(255);
  });

  it("applies soft brush falloff with hardness", () => {
    const hardMask = createFullFogMask(meta.maskWidth, meta.maskHeight);
    const softMask = createFullFogMask(meta.maskWidth, meta.maskHeight);

    applyStrokeToMask(
      hardMask,
      meta,
      buildStroke({ brush: { shape: "round", sizePx: 80, hardness: 1, mode: "reveal" } })
    );

    applyStrokeToMask(
      softMask,
      meta,
      buildStroke({ brush: { shape: "round", sizePx: 80, hardness: 0.1, mode: "reveal" } })
    );

    expect(getPixel(softMask, 130, 100)).toBeGreaterThan(getPixel(hardMask, 130, 100));
    expect(getPixel(softMask, 130, 100)).toBeLessThan(255);
  });

  it("supports square brush shape", () => {
    const mask = createFullFogMask(meta.maskWidth, meta.maskHeight);

    applyStrokeToMask(
      mask,
      meta,
      buildStroke({ brush: { shape: "square", sizePx: 80, hardness: 1, mode: "reveal" } })
    );

    expect(getPixel(mask, 135, 135)).toBe(0);
    expect(getPixel(mask, 170, 170)).toBe(255);
  });

  it("supports refog mode", () => {
    const mask = createFullFogMask(meta.maskWidth, meta.maskHeight);

    applyStrokeToMask(mask, meta, buildStroke({}));
    expect(getPixel(mask, 100, 100)).toBe(0);

    applyStrokeToMask(
      mask,
      meta,
      buildStroke({ brush: { shape: "round", sizePx: 60, hardness: 1, mode: "refog" } })
    );

    expect(getPixel(mask, 100, 100)).toBe(255);
  });

  it("supports rectangle reveal strokes", () => {
    const mask = createFullFogMask(meta.maskWidth, meta.maskHeight);

    applyStrokeToMask(mask, meta, {
      brush: { shape: "square", sizePx: 1, hardness: 1, mode: "reveal" },
      pointsWorld: [],
      timestamp: 1,
      rectangle: {
        x: 60,
        y: 70,
        width: 90,
        height: 50,
        roundness: 0,
        softness: 0,
        mode: "reveal"
      }
    });

    expect(getPixel(mask, 80, 90)).toBe(0);
    expect(getPixel(mask, 20, 20)).toBe(255);
  });

  it("supports rectangle roundness and softness", () => {
    const hardMask = createFullFogMask(meta.maskWidth, meta.maskHeight);
    const softMask = createFullFogMask(meta.maskWidth, meta.maskHeight);

    const roundedRectangleStroke: FogStroke = {
      brush: { shape: "square", sizePx: 1, hardness: 1, mode: "reveal" },
      pointsWorld: [],
      timestamp: 1,
      rectangle: {
        x: 60,
        y: 60,
        width: 80,
        height: 80,
        roundness: 0.6,
        softness: 0,
        mode: "reveal"
      }
    };

    applyStrokeToMask(hardMask, meta, roundedRectangleStroke);
    expect(getPixel(hardMask, 100, 100)).toBe(0);
    expect(getPixel(hardMask, 60, 60)).toBe(255);

    applyStrokeToMask(
      softMask,
      meta,
      {
        ...roundedRectangleStroke,
        rectangle: {
          ...roundedRectangleStroke.rectangle!,
          x: 50,
          y: 50,
          width: 100,
          height: 100,
          roundness: 0,
          softness: 0.2
        }
      }
    );

    expect(getPixel(softMask, 152, 100)).toBeLessThan(255);
    expect(getPixel(softMask, 152, 100)).toBeGreaterThan(0);
  });

  it("replayStrokes is deterministic for undo/redo history index", () => {
    const strokeA = buildStroke({ pointsWorld: [{ x: 80, y: 80 }] });
    const strokeB = buildStroke({ pointsWorld: [{ x: 120, y: 120 }] });

    const full = replayStrokes(meta, [strokeA, strokeB], 2);
    const undo = replayStrokes(meta, [strokeA, strokeB], 1);

    expect(getPixel(full, 120, 120)).toBe(0);
    expect(getPixel(undo, 120, 120)).toBe(255);
    expect(getPixel(undo, 80, 80)).toBe(0);
  });
});
