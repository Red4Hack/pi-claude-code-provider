import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  private retain = false;

  /**
   * Idempotent on purpose. Pi's RPC mode binds extensions twice for one session
   * -- its runtime rebinds on a new, resumed, forked or cloned session and the
   * command handler then rebinds again -- so `session_start` arrives twice with
   * no shutdown between. Refusing the second call only raised an extension error;
   * reusing the open store is correct, because one instance serves one session at
   * a time and the paths are content-addressed.
   */
  open(): void {
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
        // Finish a close() that deferred to this lease. Nothing else will:
        // session_shutdown arrives once, so without this the directory outlives the
        // process, and on Windows no stale-state pass ever reclaims it. A store the
        // next session has already reopened is left alone; that directory is in use.
        if (!this.openForSession && this.active === 0) void this.reclaim().catch(() => undefined);
      },
    };
  }

  async close(): Promise<void> {
    this.openForSession = false;
    // Pi emits session_shutdown before it aborts the turn, and awaits this handler
    // with no timeout of its own, so a lease still outstanding belongs to a request
    // that has not been told to stop yet: waiting for it holds Pi open for the rest
    // of the turn. Leave the directory and its recorded paths intact instead -- the
    // request keeps writing to the paths it was already given, and the last lease to
    // be released reclaims the directory from release().
    if (this.active > 0) return;
    await this.reclaim();
  }

  /**
   * Remove the session's image directory, unless a lease reported a Claude child
   * whose death could not be established. Ownership is given up before the removal
   * is awaited, so a second call -- a repeated session_shutdown, or a close() racing
   * the last release() -- is a no-op rather than a concurrent removal of one tree.
   */
  private async reclaim(): Promise<void> {
    const pending = this.directoryPromise;
    const retained = this.retain;
    this.directoryPromise = undefined;
    this.directoryPath = undefined;
    this.writes.clear();
    this.retain = false;
    if (!pending) return;
    const directory = await pending;
    if (directory && !retained) await removeRuntimeDirectory(directory);
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
    // The generated name cannot contain a quote. Check the physical root before
    // creating a store so a rejected Claude @-reference leaves no session state.
    this.directoryPromise ??= (async () => {
      const root = await realpath(tmpdir());
      if (root.includes('"')) {
        throw new ClaudeCodeError("image_path", `Images cannot be attached from a temporary directory containing a double quote: ${root}; choose a temporary directory without one (TMPDIR, or TEMP on Windows)`);
      }
      return createRuntimeDirectory("provider_image_store", { temporaryRoot: root });
    })();
    const pending = this.directoryPromise;
    try {
      const directory = await pending;
      this.directoryPath = directory;
      return directory;
    } catch (error) {
      if (this.directoryPromise === pending) this.directoryPromise = undefined;
      throw error;
    }
  }
}
