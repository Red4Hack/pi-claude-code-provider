import { ClaudeCodeError } from "./errors.ts";

export interface ClaudeInitializationExpectation {
  tools: ReadonlySet<string>;
  mcpServer: "none" | "pi";
  privatePaths?: readonly string[];
}

export interface RateLimitNotice {
  status: "allowed_warning" | "rejected";
  rateLimitType: string;
  /** Claude reports utilization as a fraction from 0 through 1. */
  utilization?: number;
  /** Reset instant normalized from Unix seconds to JavaScript milliseconds. */
  resetsAt?: number;
  overageStatus?: "allowed_warning" | "rejected";
  /** A separately reported overage reset, also normalized to milliseconds. */
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export type RateLimitNoticeSink = (notice: RateLimitNotice) => void;

/**
 * Failure text for a rate limit that rejected a provider or web-search request.
 * `normalizeClaudeUsageLimit` recognizes this wording to stop Pi retrying an
 * exhausted subscription window, so change the two together.
 */
export function rateLimitRejectionMessage(notice: RateLimitNotice): string {
  const reason = notice.overageDisabledReason === undefined ? "" : `; ${notice.overageDisabledReason}`;
  const reset = notice.resetsAt === undefined ? "" : `; resets at ${new Date(notice.resetsAt).toISOString()}`;
  return `Claude rate limit rejected (${notice.rateLimitType})${reason}${reset}`;
}

const EPOCH_MILLISECONDS_THRESHOLD = 100_000_000_000;

export function parseRateLimitNotice(info: unknown): RateLimitNotice | undefined {
  // Rate-limit events are advisory; malformed details must not fail an
  // otherwise valid provider or web-search request.
  if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
  const rate = info as Record<string, unknown>;
  const primaryStatus = alertStatus(rate.status);
  const overageStatus = alertStatus(rate.overageStatus);
  const usingOverage = rate.isUsingOverage === true;
  // org_level_disabled is the normal repeated state when usage credits are
  // unavailable, so overage constrains a request only with plan rejection/use.
  const overageBlocking = overageStatus === "rejected" && (primaryStatus === "rejected" || usingOverage);
  if (!primaryStatus && !overageBlocking) return undefined;
  const status = primaryStatus === "rejected" || overageBlocking ? "rejected" : "allowed_warning";
  const hasPrimaryAlert = primaryStatus !== undefined;
  const overageRelevant = overageStatus !== undefined && (primaryStatus === "rejected" || usingOverage);
  const rateLimitType = hasPrimaryAlert
    ? typeof rate.rateLimitType === "string" && rate.rateLimitType.trim() ? rate.rateLimitType.trim() : "unknown"
    : "overage";
  const overageReset = validTimestamp(rate.overageResetsAt);
  const resetsAt = validTimestamp(hasPrimaryAlert ? rate.resetsAt : rate.overageResetsAt);
  const utilization = validUtilization(rate.utilization);
  const reason = typeof rate.overageDisabledReason === "string" && rate.overageDisabledReason.trim()
    ? rate.overageDisabledReason.trim()
    : undefined;
  return {
    status,
    rateLimitType,
    ...(hasPrimaryAlert && utilization !== undefined ? { utilization } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(overageRelevant ? { overageStatus } : {}),
    ...(overageRelevant && hasPrimaryAlert && overageReset !== undefined ? { overageResetsAt: overageReset } : {}),
    ...(overageRelevant && reason !== undefined ? { overageDisabledReason: reason } : {}),
    ...(usingOverage ? { isUsingOverage: true } : {}),
  };
}

export function terminalResultErrorDetail(
  record: Record<string, unknown>,
  assistantDiagnostic?: string,
  rateLimitFailure?: string,
): string {
  const result = typeof record.result === "string" && record.result.trim() ? record.result.trim() : undefined;
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((error): error is string => typeof error === "string" && Boolean(error.trim())).join("; ")
    : "";
  const terminal = typeof record.terminal_reason === "string" && record.terminal_reason.trim()
    ? record.terminal_reason.trim()
    : undefined;
  return result ?? assistantDiagnostic ?? (errors || undefined) ?? terminal ?? rateLimitFailure ?? "unknown error";
}

// The API's rejection when a request carries more cache_control blocks than it
// permits. Matched loosely: the wording comes from the API, not from Claude Code.
const CACHE_BREAKPOINT_LIMIT = /maximum of \d+ blocks with cache_control/i;

/** Whether a terminal failure is the API's cache-breakpoint limit. */
export function isCacheBreakpointLimit(detail: string): boolean {
  return CACHE_BREAKPOINT_LIMIT.test(detail);
}

export function validateClaudeInitialization(value: unknown, expectation: ClaudeInitializationExpectation): string {
  const record = requireRecord(value, "Claude initialization");
  if (record.type !== "system" || record.subtype !== "init") {
    throw new ClaudeCodeError("protocol_init", "Claude initialization record was invalid");
  }
  if (!Array.isArray(record.tools)) throw new ClaudeCodeError("protocol_init", "Claude initialization omitted tools");
  if (record.tools.some((tool) => typeof tool !== "string")) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization contained an invalid tool name");
  }
  const tools = new Set(record.tools as string[]);
  if (tools.size !== record.tools.length || tools.size !== expectation.tools.size || [...tools].some((tool) => !expectation.tools.has(tool))) {
    throw new ClaudeCodeError(
      "isolation_tools",
      `Claude Code initialized with an unexpected tool set (expected: ${formatNames(expectation.tools)}; observed: ${formatNames(tools)})`,
    );
  }
  if (record.permissionMode !== "dontAsk") {
    throw new ClaudeCodeError("isolation_permissions", "Claude Code did not enter dontAsk permission mode");
  }
  if (!Array.isArray(record.slash_commands) || !Array.isArray(record.skills) || !Array.isArray(record.plugins)) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization omitted customization inventories");
  }
  if (record.slash_commands.length > 0 || record.skills.length > 0 || record.plugins.length > 0) {
    const loaded = (["plugins", "skills", "slash_commands"] as const)
      .filter((field) => (record[field] as unknown[]).length > 0)
      .map((field) => `${field}: ${inventoryNames(record[field] as unknown[])}`);
    throw new ClaudeCodeError("isolation_customizations", `Claude Code loaded unexpected customizations (${loaded.join("; ")})`);
  }
  if (record.apiKeySource !== "none") {
    throw new ClaudeCodeError("isolation_auth", "Claude Code did not confirm subscription-backed authentication");
  }
  if (record.mcp_server_errors !== undefined) {
    if (!Array.isArray(record.mcp_server_errors)) {
      throw new ClaudeCodeError("protocol_init", "Claude initialization contained invalid MCP server errors");
    }
    if (record.mcp_server_errors.length > 0) {
      const details = record.mcp_server_errors.map((value) => mcpErrorDetail(value, expectation.privatePaths ?? []));
      throw new ClaudeCodeError("isolation_mcp", `Claude Code reported MCP initialization errors: ${details.join("; ")}`);
    }
  }
  if (!Array.isArray(record.mcp_servers)) throw new ClaudeCodeError("protocol_init", "Claude initialization omitted MCP inventory");
  const servers = record.mcp_servers as Array<{ name?: unknown; status?: unknown }>;
  if (expectation.mcpServer === "none") {
    if (servers.length > 0) {
      throw new ClaudeCodeError("isolation_mcp", `Claude Code loaded an unexpected MCP server (${inventoryNames(servers)})`);
    }
  } else if (servers.length !== 1 || servers[0]?.name !== "pi" || servers[0]?.status !== "connected") {
    throw new ClaudeCodeError("isolation_mcp", "The Pi proposal MCP server did not initialize correctly");
  }
  if (typeof record.model !== "string" || record.model.length === 0) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization omitted the resolved model");
  }
  return record.model;
}

function mcpErrorDetail(value: unknown, privatePaths: readonly string[]): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization contained an invalid MCP server error");
  }
  const error = value as Record<string, unknown>;
  if (typeof error.type !== "string" || !error.type.trim() || typeof error.message !== "string" || !error.message.trim()) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization contained an invalid MCP server error");
  }
  return `${safeDiagnostic(error.type, privatePaths, 64)}: ${safeDiagnostic(error.message, privatePaths, 512)}`;
}

function safeDiagnostic(value: string, privatePaths: readonly string[], limit: number): string {
  return redactDiagnostic(value, privatePaths).slice(0, limit);
}

/**
 * The tail of a Claude child's stderr, fit for an error message: one line,
 * bounded, and with private paths replaced. The tail is kept because the last
 * lines a failing process writes usually explain the failure.
 */
export function stderrExcerpt(stderr: string, privatePaths: readonly string[], maxChars = 1_000): string {
  return redactDiagnostic(stderr, privatePaths).slice(-maxChars).trim();
}

function redactDiagnostic(value: string, privatePaths: readonly string[]): string {
  let safe = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  for (const path of [...privatePaths].sort((left, right) => right.length - left.length)) {
    if (path) safe = safe.split(path).join("<PRIVATE>");
  }
  return safe;
}

function validTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // The current wire value is Unix seconds. Avoid double conversion if a future
  // CLI or intermediary supplies a plausible epoch-millisecond value.
  const milliseconds = value >= EPOCH_MILLISECONDS_THRESHOLD ? value : value * 1000;
  return !Number.isSafeInteger(milliseconds) || Number.isNaN(new Date(milliseconds).getTime()) ? undefined : milliseconds;
}

function validUtilization(value: unknown): number | undefined {
  // Keep the wire fraction intact; rendering is the only percentage boundary.
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function alertStatus(value: unknown): RateLimitNotice["status"] | undefined {
  return value === "allowed_warning" || value === "rejected" ? value : undefined;
}

/** A record's `type/subtype`, bounded, to name the record a protocol failure rejected. */
export function recordKind(record: { type?: unknown; subtype?: unknown }): string {
  const part = (value: unknown) => (typeof value === "string" ? value.replace(/[^\w.-]/g, "").slice(0, 48) : "");
  const type = part(record.type) || "untyped";
  const subtype = part(record.subtype);
  return subtype ? `${type}/${subtype}` : type;
}

/**
 * Up to five names from an initialization inventory, whose entries are strings or
 * objects carrying a `name`. Bounded, and never a path: entries can carry one.
 */
function inventoryNames(entries: readonly unknown[]): string {
  const names = entries.slice(0, 5).map((entry) => {
    const name = typeof entry === "string" ? entry : (entry as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || name.length === 0) return "unnamed";
    return /[\\/]/.test(name) ? "<path>" : name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
  });
  return `${names.join(", ")}${entries.length > 5 ? `, and ${entries.length - 5} more` : ""}`;
}

function formatNames(names: ReadonlySet<string>): string {
  return [...names].sort().join(", ") || "none";
}

/** Narrow an untrusted protocol value to a plain object, or fail with its field name. */
export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudeCodeError("protocol_shape", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
