import { promises as fs } from "node:fs";

import { imageSize } from "image-size";
import { PDFDocument } from "pdf-lib";

import type { MapPageMeta } from "../../shared/src/types";

export interface ParsedMapMeta {
  kind: "image" | "pdf";
  width: number;
  height: number;
  pdfPageCount: number;
  pages?: MapPageMeta[];
}

export async function parseMapMetadata(filePath: string, mimeType: string): Promise<ParsedMapMeta> {
  if (mimeType === "application/pdf") {
    const fileBuffer = await fs.readFile(filePath);
    const pdf = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const pages = pdf.getPages().map((page) => ({
      width: Math.max(1, Math.round(page.getWidth())),
      height: Math.max(1, Math.round(page.getHeight()))
    }));

    if (pages.length === 0) {
      throw new Error("PDF has no pages");
    }

    return {
      kind: "pdf",
      width: pages[0].width,
      height: pages[0].height,
      pdfPageCount: pages.length,
      pages
    };
  }

  const imageBuffer = await fs.readFile(filePath);
  const dimensions = imageSize(imageBuffer);
  if (!dimensions.width || !dimensions.height) {
    throw new Error("Could not read image dimensions");
  }

  return {
    kind: "image",
    width: dimensions.width,
    height: dimensions.height,
    pdfPageCount: 1,
    pages: [{ width: dimensions.width, height: dimensions.height }]
  };
}
