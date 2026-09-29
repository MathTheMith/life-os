import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { uploadsDir } from "./db.js";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
// The frontend resizes/compresses before sending, so this is a backstop
// against a much bigger file slipping through some other client, not the
// primary size control.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Saves a data: URI image to disk under a random name and returns its
 * served path (/api/uploads/...) — so a saved conversation's images survive
 * a reload without keeping the full base64 payload in the database, and a
 * guessable path isn't handed out for something meant to be private.
 */
export function saveImageDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) throw new Error("Format d'image invalide.");
  const [, mime, base64] = match;
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error(`Type d'image non supporté : ${mime}`);
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image trop lourde (max 8 Mo).");
  const filename = `${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  return `/api/uploads/${filename}`;
}
