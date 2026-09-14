export const VERIFIED_VERSIONS = Object.freeze({
  pi: "0.85.1",
  claudeCode: "2.1.270",
});

// The oldest Pi and Claude Code this provider claims to support. Deliberately
// NOT derived from VERIFIED_VERSIONS, which records the newest versions a paid
// gate has validated and rises on its own schedule. These fall or rise only by
// an explicit decision about what is supported, so deriving one from the other
// would turn every baseline bump into a silent, unreviewed support drop. Assert
// nothing about their relative order.
export const MINIMUM_VERSIONS = Object.freeze({
  pi: "0.85.1",
  claudeCode: "2.1.270",
});

const VERIFIED_PLATFORMS = "Linux/linux-x64, including WSL2; native Windows/win32-x64; macOS/darwin";

// Which family an alias must serve, not which dated model. Claude Code refreshes
// model versions on its own schedule; pinning exact ids only guarantees the paid
// gate fails on a release that changed nothing here.
export const EXPECTED_MODEL_FAMILIES = Object.freeze({
  sonnet: /^claude-sonnet-/,
  fable: /^claude-fable-/,
  opus: /^claude-opus-/,
  haiku: /^claude-haiku-/,
});

export interface VersionStatus {
  component: string;
  current: string;
  verified: string;
  isVerified: boolean;
  minimum?: string;
  meetsMinimum?: boolean;
  warning?: string;
}

/**
 * Compare dotted version triples numerically. Lexical comparison gets this
 * wrong in exactly the range that matters: "2.1.9" sorts above "2.1.241".
 */
export function meetsMinimumVersion(current: string, minimum: string): boolean {
  const parse = (value: string) => (value.match(/\d+/g) ?? []).map(Number);
  const left = parse(current);
  const right = parse(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function platformStatus(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): VersionStatus {
  const current = `${platform}/${architecture}`;
  if (platform === "win32" && architecture === "x64") {
    return {
      component: "Platform",
      current,
      verified: VERIFIED_PLATFORMS,
      isVerified: true,
    };
  }
  if (platform === "win32") {
    return {
      component: "Platform",
      current,
      verified: VERIFIED_PLATFORMS,
      isVerified: false,
      warning: `${current} is unverified; the native Windows verified baseline is x64`,
    };
  }
  // Verified across distributions rather than for WSL2 Ubuntu alone: the gate
  // runs on linux/x64, which is exactly what WSL2 Ubuntu is, and nothing here
  // takes a different code path on another distribution or kernel. The same
  // reasoning applies to macOS architectures below. Architecture still counts,
  // because that is what decides which Claude Code build is installed at all.
  if (platform === "linux" && architecture === "x64") {
    return {
      component: "Platform",
      current,
      verified: VERIFIED_PLATFORMS,
      isVerified: true,
    };
  }
  if (platform === "linux") {
    return {
      component: "Platform",
      current,
      verified: VERIFIED_PLATFORMS,
      isVerified: false,
      warning: `${current} is a compatibility candidate; the verified platform baselines are ${VERIFIED_PLATFORMS}`,
    };
  }
  // Verified across architectures rather than per-arch: macOS coverage is the
  // deterministic CI matrix, and this package has no darwin-specific code path
  // that an Intel Mac would take differently.
  if (platform === "darwin") {
    return {
      component: "Platform",
      current,
      verified: VERIFIED_PLATFORMS,
      isVerified: true,
    };
  }
  return {
    component: "Platform",
    current,
    verified: VERIFIED_PLATFORMS,
    isVerified: false,
    warning: `${current} is unverified; continuing with runtime validation`,
  };
}

/** Dismiss only the startup advisory for an explicitly acknowledged platform.
 * Doctor/report metadata and runtime validation remain unchanged.
 */
export function startupPlatformWarning(
  status: VersionStatus,
  acknowledgedPlatform: string | undefined = process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM,
): string | undefined {
  return acknowledgedPlatform === status.current ? undefined : status.warning;
}

/**
 * Return verification metadata; mismatches never block execution by themselves.
 * A minimum is reported through its own fields rather than through `warning`,
 * which belongs to the platform advisory and its acknowledgement.
 */
export function versionStatus(
  component: string,
  current: string,
  verified: string,
  minimum?: string,
): VersionStatus {
  return {
    component,
    current,
    verified,
    isVerified: current === verified,
    ...(minimum === undefined ? {} : { minimum, meetsMinimum: meetsMinimumVersion(current, minimum) }),
  };
}
