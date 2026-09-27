import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The provider package Pi actually loaded. Pi can keep a project-local install ahead of
 * a newer global one, and loads npm and Git installs side by side, so the doctor names
 * the running copy rather than trusting the version a user believes is installed.
 */
export interface ProviderPackage {
  version: string | undefined;
  root: string;
}

const MANIFEST = new URL("../package.json", import.meta.url);

/** Fail-soft: a diagnostic must never fail because the manifest is unreadable. */
export async function readProviderPackage(manifest: URL = MANIFEST): Promise<ProviderPackage> {
  const root = dirname(fileURLToPath(manifest));
  try {
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as unknown;
    const version = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).version
      : undefined;
    return { version: typeof version === "string" ? version : undefined, root };
  } catch {
    return { version: undefined, root };
  }
}
