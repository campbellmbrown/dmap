import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import type { MapAsset } from "@shared/types";
import { mapFileUrl } from "./api";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export interface LoadedMapSurface {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  pageCount: number;
}

async function loadImageSurface(url: string): Promise<LoadedMapSurface> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image map"));
    img.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create map render context");
  }

  context.drawImage(image, 0, 0);

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    pageCount: 1
  };
}

async function loadPdfSurface(url: string, pageNumber: number): Promise<LoadedMapSurface> {
  const task = pdfjsLib.getDocument(url);
  const pdf = await task.promise;
  const clampedPageNumber = Math.max(1, Math.min(pageNumber, pdf.numPages));
  const page = await pdf.getPage(clampedPageNumber);
  const viewport = page.getViewport({ scale: 1 });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create PDF render context");
  }

  await page.render({
    canvas,
    canvasContext: context,
    viewport
  }).promise;

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    pageCount: pdf.numPages
  };
}

export async function loadMapSurface(mapAsset: MapAsset, pageNumber: number): Promise<LoadedMapSurface> {
  const sourceUrl = mapFileUrl(mapAsset.id);

  if (mapAsset.kind === "pdf") {
    return loadPdfSurface(sourceUrl, pageNumber);
  }

  return loadImageSurface(sourceUrl);
}
