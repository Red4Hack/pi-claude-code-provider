import { constants } from "node:fs";
import { accessSync, closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, parse } from "node:path";

function findOnPath(name) {
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.toLowerCase())]
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // Try the next extension or PATH entry.
      }
    }
  }
  throw new Error(`${name} was not found on PATH`);
}

function packageName(name) {
  return name === "typebox" ? name : `@earendil-works/${name}`;
}

function isPackageRoot(directory, name) {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === packageName(name);
  } catch {
    // Not a readable package root, or not the package being looked for.
    return false;
  }
}

function firstPackageRoot(candidates, name, detail = "") {
  for (const candidate of candidates) {
    if (isPackageRoot(candidate, name)) return candidate;
  }
  throw new Error(`Cannot resolve Pi's bundled ${packageName(name)}${detail}`);
}

/**
 * Find the package that owns a file by walking ancestors. The CLI entry's depth
 * under the package is Pi's build detail and has changed before, so no fixed
 * depth is assumed.
 */
function ancestorPackageRoot(start, name) {
  let directory = dirname(start);
  const { root } = parse(directory);
  for (;;) {
    if (isPackageRoot(directory, name)) return directory;
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}

export const PI_BIN_ENV = "PI_CLAUDE_CODE_PROVIDER_PI_BIN";
export const DEV_PI_ENV = "PI_CLAUDE_CODE_PROVIDER_DEV_PI";

// Native executable magic numbers. Detect these positively rather than treating
// "not a shebang" as compiled: npm's Windows shim is a .cmd batch file, and
// misreading it as a standalone binary would reject a working npm install.
const EXECUTABLE_MAGIC = [
  "7f454c46", // ELF
  "4d5a", // PE (Windows .exe)
  "cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", // Mach-O, including universal
];

/** Whether a path is a compiled native executable rather than a script or shim. */
export function isCompiledPi(executable) {
  let handle;
  try {
    handle = openSync(executable, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(4);
    const read = readSync(handle, header, 0, 4, 0);
    const hex = header.subarray(0, read).toString("hex");
    return EXECUTABLE_MAGIC.some((magic) => hex.startsWith(magic));
  } finally {
    closeSync(handle);
  }
}

/**
 * The pi executable development resolves packages from: DEV_PI_ENV when set, so
 * a standalone Pi can stay first on PATH, otherwise the first pi on PATH. It is
 * resolved to its real file because package resolution walks up from the CLI
 * entry, and an npm bin link lives outside the package.
 */
function developmentPi() {
  const override = process.env[DEV_PI_ENV]?.trim();
  if (!override) return findOnPath("pi");
  try {
    // Windows reports no execute bit; check existence there instead.
    accessSync(override, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return realpathSync(override);
  } catch {
    throw new Error(`${DEV_PI_ENV} is set to ${override}, which is not an executable file`);
  }
}

/**
 * Resolve Pi's packages for type resolution and module imports from the
 * development Pi; piCliEntry, and piLaunch without PI_BIN_ENV, follow the same
 * Pi. This is a development-host requirement and is deliberately separate from
 * PI_BIN_ENV: a standalone Pi can be launched but resolves no packages.
 */
export function locatePiPackages() {
  const piCli = developmentPi();
  try {
    return resolvePiPackages(piCli);
  } catch (error) {
    // Diagnose only after resolution actually failed. A guess that runs first
    // can reject an installation that would have resolved perfectly well.
    if (!isCompiledPi(piCli)) throw error;
    throw new Error(
      `${piCli} is a compiled standalone Pi that bundles its packages and exposes none of them. ` +
      "Development requires an npm-installed Pi: put one first on PATH (npm install -g @earendil-works/pi-coding-agent) " +
      `or set ${DEV_PI_ENV} to its pi executable; ` +
      `the standalone build stays a supported runtime target, and ${PI_BIN_ENV} points the live tests at it.`,
      { cause: error },
    );
  }
}

function resolvePiPackages(piCli) {
  const shimDirectory = dirname(piCli);
  const owningPackage = ancestorPackageRoot(piCli, "pi-coding-agent");
  const codingAgent = firstPackageRoot(
    [
      // pi.dev's Windows installer keeps its shims beside node_modules, so the
      // package is not an ancestor of the shim and must be tried first.
      join(shimDirectory, "node_modules", "@earendil-works", "pi-coding-agent"),
      ...(owningPackage ? [owningPackage] : []),
    ],
    "pi-coding-agent",
    ` for the pi executable at ${piCli}; reinstall the active pi executable or update the tooling`,
  );
  const nestedModules = join(codingAgent, "node_modules");
  const globalModules = dirname(dirname(codingAgent));
  return {
    codingAgent,
    piAi: firstPackageRoot(
      [join(nestedModules, "@earendil-works", "pi-ai"), join(dirname(codingAgent), "pi-ai")],
      "pi-ai",
    ),
    typebox: firstPackageRoot([join(nestedModules, "typebox"), join(globalModules, "typebox")], "typebox"),
  };
}

export function piCliEntry(codingAgent = locatePiPackages().codingAgent) {
  const manifest = JSON.parse(readFileSync(join(codingAgent, "package.json"), "utf8"));
  const entry = manifest.bin?.pi;
  if (typeof entry !== "string") throw new Error(`Cannot resolve Pi's CLI entry at ${codingAgent}`);
  return join(codingAgent, entry);
}

/**
 * Resolve how to launch Pi, independently of package resolution, so the live
 * tests can exercise either distribution from one npm-hosted development host.
 */
export function piLaunch(args = []) {
  const override = piBinOverride();
  if (!override) return { command: process.execPath, args: [piCliEntry(), ...args] };
  // Windows cannot execute a JavaScript entry without a shell; everything else,
  // including a compiled standalone binary, is launched directly.
  return /\.[cm]?js$/i.test(override)
    ? { command: process.execPath, args: [override, ...args] }
    : { command: override, args: [...args] };
}

/** Live validation must not discover personal skills, context, or executable extensions. */
export function livePiLaunch(args = []) {
  return piLaunch([
    "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
    ...args,
  ]);
}

/** Read and validate the launcher override, so a typo fails by name rather than as ENOENT at spawn. */
export function piBinOverride() {
  const override = process.env[PI_BIN_ENV]?.trim();
  if (!override) return undefined;
  if (process.platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(override)) {
    throw new Error(
      `${PI_BIN_ENV} is set to ${override}, and Windows shims cannot be launched without a shell. ` +
      "Point it at pi.exe from the standalone zip, or unset it to use the npm-hosted entry.",
    );
  }
  try {
    // Windows reports no execute bit; the repo checks existence there instead.
    accessSync(override, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw new Error(`${PI_BIN_ENV} is set to ${override}, which is not an executable file`);
  }
  return override;
}

/** Name the Pi distribution a live run is exercising, so lanes stay distinguishable in output. */
export function describePiLaunch() {
  const override = piBinOverride();
  if (!override) return "npm-hosted Pi";
  return `${isCompiledPi(override) ? "standalone" : "npm-hosted"} Pi at ${override}`;
}

export function packageEntry(packageRoot, condition, subpath = ".") {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const fallback = subpath === "." ? (condition === "import" ? manifest.module : manifest.types) : undefined;
  const entry = manifest.exports?.[subpath]?.[condition] ?? fallback;
  if (typeof entry !== "string") {
    throw new Error(`Cannot resolve the ${condition} entry for ${manifest.name}${subpath === "." ? "" : subpath.slice(1)} at ${packageRoot}`);
  }
  return join(packageRoot, entry);
}
