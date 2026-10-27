import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";

// Pi pastes a clipboard image as the path of a pi-clipboard-<uuid> file in the temp directory.
const PASTED_PATH = /(?:[A-Za-z]:)?[^\s"'<>|*?]*pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|gif|webp)/gi;

const MAX_PASTED_BYTES = 20 * 1024 * 1024;

// The type comes from the bytes, not the extension: a mislabelled file would make the API reject the whole turn.
function sniffMime(b: Buffer): string | undefined {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

const same = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Replace each pasted clipboard-image path with `[image #N]` and return the files
 * as image content. Only files directly in the temp directory qualify, so typing
 * some other path can never make the provider read it.
 */
export async function extractPastedImages(
  text: string,
  firstNumber: number,
): Promise<{ text: string; images: ImageContent[]; next: number }> {
  const root = await realpath(tmpdir());
  const images: ImageContent[] = [];
  let out = "";
  let last = 0;
  let next = firstNumber;
  for (const match of text.matchAll(PASTED_PATH)) {
    const path = match[0];
    try {
      if (!same(await realpath(dirname(path)), root)) continue;
      // lstat, not stat: /tmp is shared, so a symlink planted under this name must not be followed.
      const info = await lstat(path);
      if (!info.isFile() || info.size === 0 || info.size > MAX_PASTED_BYTES) continue;
      if (process.platform !== "win32" && info.uid !== process.getuid?.()) continue;
      const bytes = await readFile(path);
      const mimeType = sniffMime(bytes);
      if (!mimeType) continue;
      images.push({ type: "image", data: bytes.toString("base64"), mimeType });
    } catch {
      continue; // gone or unreadable: leave the path as pasted
    }
    out += `${text.slice(last, match.index)}[image #${next++}]`;
    last = match.index + path.length;
  }
  return { text: out + text.slice(last), images, next };
}
