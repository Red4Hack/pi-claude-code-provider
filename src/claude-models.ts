import { open, stat } from "node:fs/promises";
import type { ClaudeInstallation } from "./types.ts";

/**
 * Report which concrete model each picker alias would be served, by reading the
 * CLI's `aliases` table embedded in the Claude Code executable.
 *
 * This is an undocumented internal, and a deliberate, scoped exception to this
 * project's rule of consuming only published interfaces. It is the only
 * zero-cost source that can report every alias: `system/init` resolves them
 * but is unreachable without a billed turn, and a model that is never served is
 * never observed, so Fable could not be reported on a Pro account at all.
 *
 * The names it finds decide which models the picker lists, never which model
 * serves a request: the serving path stays alias-only, which is what makes a
 * wrong answer here harmless. With nothing found, the catalog falls back to its
 * built-in aliases. Every failure mode leaves the alias
 * out, which the doctor reports as "undetermined", rather than reporting a
 * version it is not sure of.
 */
// Any alias the table names is read, so a new model needs no code change here.
export type ModelAliasVersions = Record<string, string>;

// The executable also embeds `provider_alias_targets` tables, the model-selector
// state of other Claude surfaces. They name different ids for the same aliases
// (2.1.281's say claude-opus-5 where the CLI serves claude-opus-5-5), so only the
// literal `aliases:{...}` table is read. Its name does not occur inside
// `provider_alias_targets`, and minified code that builds an `aliases` object
// holds expressions rather than quoted ids, so neither can match.
//
// Only `default:` can apply here. src/auth.ts rejects anything that is not
// firstParty, so reading a per-provider override would report a model this
// extension can never serve.
const ALIAS_ENTRY = String.raw`[a-z][a-z0-9-]{0,31}:\{default:"[A-Za-z0-9._-]{1,64}"(?:,per_provider:\{[^{}]{0,512}\})?\}`;
const TABLE_PATTERN = new RegExp(String.raw`\baliases:\{(${ALIAS_ENTRY}(?:,${ALIAS_ENTRY}){0,15})\}`, "g");
const ALIAS_PATTERN = /\b([a-z][a-z0-9-]{0,31}):\{default:"([A-Za-z0-9._-]{1,64})"/g;
const CHUNK_BYTES = 1024 * 1024;
// Longer than the longest table TABLE_PATTERN can match (sixteen entries of at most
// about 620 bytes), so carrying it between chunks is enough.
const OVERLAP_BYTES = 16 * 1024;
const SCAN_TIMEOUT_MS = 10_000;

// Per concrete model id, from the same executable: window, default output cap and
// whether it takes an effort level. A new model's limits need no code change.
export interface ModelLimits { contextWindow: number; maxTokens: number; effort: boolean }
const MODEL_ENTRY = /provider_ids:\{first_party:"([A-Za-z0-9._-]{1,64})".{0,900}?context:\{window:([0-9.e]{1,12}).{0,200}?max_output_tokens:\{default:(\d{1,9}).{0,300}?capabilities:\[([^\]]{0,600})\]/g;
export type ModelLimitTable = Record<string, ModelLimits>;
// Built-in plugin names, so the pinned settings can disable each one Claude Code ships.
const PLUGIN_PATTERN = /\bcc-plugin-([a-z][a-z0-9-]{0,40})|\b([a-z][a-z0-9-]{0,40})@builtin\b/g;
const MAX_PLUGINS = 64;
interface Scanned { versions: ModelAliasVersions; limits: ModelLimitTable; plugins: string[] }
const EMPTY = (): Scanned => ({ versions: {}, limits: {}, plugins: [] });

let cache: ({ key: string } & Scanned) | undefined;

export async function readClaudeModelAliases(installation: ClaudeInstallation, timeoutMs = SCAN_TIMEOUT_MS): Promise<ModelAliasVersions> {
  return (await load(installation, timeoutMs)).versions;
}

export async function readClaudeBuiltinPlugins(installation: ClaudeInstallation, timeoutMs = SCAN_TIMEOUT_MS): Promise<string[]> {
  return (await load(installation, timeoutMs)).plugins;
}

export async function readClaudeModelLimits(installation: ClaudeInstallation, timeoutMs = SCAN_TIMEOUT_MS): Promise<ModelLimitTable> {
  return (await load(installation, timeoutMs)).limits;
}

async function load(installation: ClaudeInstallation, timeoutMs: number): Promise<Scanned> {
  const path = installation.executable;
  let key: string;
  try {
    const info = await stat(path);
    key = `${path}:${info.size}:${info.mtimeMs}`;
  } catch {
    return EMPTY();
  }
  if (cache?.key === key) return cache;
  const scanned = await scan(path, timeoutMs);
  cache = { key, ...scanned };
  return scanned;
}

async function scan(path: string, timeoutMs: number): Promise<Scanned> {
  const deadline = Date.now() + timeoutMs;
  const found = new Map<string, Set<string>>();
  const limits = new Map<string, ModelLimits | null>();
  const plugins = new Set<string>();
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return EMPTY();
  }
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let tail = "";
    for (;;) {
      if (Date.now() > deadline) return EMPTY();
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      // latin1 maps every byte to one character, so offsets stay meaningful in
      // a binary and no byte sequence can decode into a spurious match.
      const text = tail + buffer.subarray(0, bytesRead).toString("latin1");
      for (const table of text.matchAll(TABLE_PATTERN)) {
        for (const match of (table[1] ?? "").matchAll(ALIAS_PATTERN)) {
          const alias = match[1];
          const model = match[2];
          if (alias === undefined || model === undefined) continue;
          const values = found.get(alias) ?? new Set<string>();
          values.add(model);
          found.set(alias, values);
        }
      }
      for (const m of text.matchAll(PLUGIN_PATTERN)) {
        const name = m[1] ?? m[2];
        if (name && plugins.size < MAX_PLUGINS) plugins.add(name);
      }
      for (const m of text.matchAll(MODEL_ENTRY)) {
        const [, id, window, output, caps] = m;
        const contextWindow = Number(window);
        const maxTokens = Number(output);
        if (id === undefined || !(contextWindow > 0) || !(maxTokens > 0)) continue;
        const next = { contextWindow, maxTokens, effort: /"effort"/.test(caps ?? "") };
        const prior = limits.get(id);
        // Conflicting entries for one id mean the shape changed: report nothing for it.
        limits.set(id, prior === undefined || (prior && JSON.stringify(prior) === JSON.stringify(next)) ? next : null);
      }
      tail = text.slice(-OVERLAP_BYTES);
    }
  } catch {
    return EMPTY();
  } finally {
    await handle.close().catch(() => undefined);
  }
  const versions: ModelAliasVersions = {};
  for (const [alias, values] of found) {
    // A second, different value means the table's shape has changed. Guessing
    // would report a wrong version confidently, which is worse than reporting
    // nothing.
    if (values.size === 1) versions[alias] = [...values][0]!;
  }
  const table: ModelLimitTable = {};
  for (const [id, value] of limits) if (value) table[id] = value;
  return { versions, limits: table, plugins: [...plugins].sort() };
}

/** Reset the scan cache. Exported for tests, which reuse one executable path. */
export function clearModelAliasCache(): void {
  cache = undefined;
}
