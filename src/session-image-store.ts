import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeCodeError, errorCode } from "./errors.ts";
import { createRuntimeDirectory, removeRuntimeDirectory } from "./runtime-directories.ts";

/** One active Pi session owns the stable paths, never a project directory. */
export interface ImageStoreLease {
  put(name: string, bytes: Buffer): Promise<string>;
  readonly directory: string | undefined;
  release(livenessUnknown?: boolean): void;
}

export class SessionImageStore {
  private openForSession = false;
  private directoryPromise: Promise<string> | undefined;
  private directoryPath: string | undefined;
  private writes = new Map<string, Promise<string>>();
  private active = 0;
  private idle: (() => void)[] = [];
  private retain = false;

  open(): void {
    if (this.openForSession || this.active !== 0 || this.directoryPromise) {
      throw new Error("Image store session was opened before its previous session closed");
    }
    this.openForSession = true;
  }

  acquire(): ImageStoreLease {
    if (!this.openForSession) throw new ClaudeCodeError("image_path", "Pi's image store is unavailable outside an active session");
    this.active += 1;
    const owner = this;
    let released = false;
    return {
      put: (name, bytes) => this.put(name, bytes),
      get directory() { return owner.directoryPath; },
      release: (livenessUnknown = false) => {
        if (released) return;
        released = true;
        if (livenessUnknown) this.retain = true;
        this.active -= 1;
        if (this.active === 0) this.idle.splice(0).forEach((resolve) => resolve());
      },
    };
  }

  async close(): Promise<void> {
    this.openForSession = false;
    if (this.active > 0) await new Promise<void>((resolve) => this.idle.push(resolve));
    try {
      const directory = await this.directoryPromise;
      if (directory && !this.retain) await removeRuntimeDirectory(directory);
    } finally {
      this.directoryPromise = undefined;
      this.directoryPath = undefined;
      this.writes.clear();
      this.retain = false;
    }
  }

  private async put(name: string, bytes: Buffer): Promise<string> {
    if (!/^image-[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/.test(name)) {
      throw new ClaudeCodeError("image_path", "Invalid generated image filename");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!name.startsWith(`image-${digest}.`)) throw new ClaudeCodeError("image_path", "Image filename does not match its bytes");
    const pending = this.writes.get(name);
    if (pending) return pending;
    const write = (async () => {
      const directory = await this.ensureDirectory();
      const path = join(directory, name);
      try {
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const info = await lstat(path);
        if (!info.isFile() || !(await readFile(path)).equals(bytes)) {
          throw new ClaudeCodeError("image_path", "Image store contains mismatched or unsafe image bytes");
        }
      }
      return path;
    })();
    this.writes.set(name, write);
    try { return await write; } finally { this.writes.delete(name); }
  }

  private async ensureDirectory(): Promise<string> {
    this.directoryPromise ??= createRuntimeDirectory("provider_image_store");
    const directory = await this.directoryPromise;
    this.directoryPath = directory;
    return directory;
  }
}
