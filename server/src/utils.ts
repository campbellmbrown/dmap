import path from "node:path";

import { extension } from "mime-types";

export function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName);
  return baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function extensionFromMimeType(mimeType: string): string {
  const ext = extension(mimeType);
  return ext ? `.${ext}` : "";
}
