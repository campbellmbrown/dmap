import crypto from "node:crypto";
import path from "node:path";

import { extension } from "mime-types";

export function createRoomCode(length: number = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);

  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += alphabet[bytes[i] % alphabet.length];
  }

  return result;
}

export function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName);
  return baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function extensionFromMimeType(mimeType: string): string {
  const ext = extension(mimeType);
  return ext ? `.${ext}` : "";
}
