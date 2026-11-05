import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MODE, DEFAULT_ZCODE_COMMAND, ZCODE_MODES, type ZcodeMode } from "../shared/constants.js";

/**
 * Adapter-side security policy (NFMA-540, L2 — defence in depth).
 *
 * The server-side allow-list (NFMA-539, L1) is the authoritative fix: it stops
 * an agent from writing `zcodeCommand` / `envVars` / `mode` / `disallowedTools`
 * into `adapterConfig` at all. This module is the SECOND layer, and it has a
 * different job: it holds even when the server-side gate is bypassed, because
 * the adapter is what actually spawns the child process.
 *
 * It therefore raises the bar rather than closing the hole. An agent with
 * `Bash` can still write an executable and point `zcodeCommand` at it; what
 * the adapter guarantees is that the value it honours is a real, existing,
 * executable file at an absolute path, that the runtime-root environment
 * variable cannot be redirected through a traversal, that the loader/loader-
 * hijack environment variables cannot be overridden, and that an unknown
 * permission mode never silently degrades to the most permissive one.
 */

/**
 * Environment variable names that may not be set from adapter config.
 *
 * These are matched EXACTLY (case-sensitive), which is the right granularity
 * on macOS and Linux: the process environment is case-sensitive there, and the
 * names below are consumed by case-sensitive consumers (the dynamic linker
 * reads `DYLD_*`/`LD_*`, the loader reads `NODE_OPTIONS`, the shell and every
 * spawned tool read `PATH`/`HOME`).
 *
 * - `ZCODE_SERVER_RUNTIME_ROOT` — selects the `node` binary that runs the
 *   ZCode app bundle. Overriding it points the run at an attacker-chosen
 *   interpreter, which is the shim hijack chain.
 * - `LD_PRELOAD` / `LD_LIBRARY_PATH` — inject code into every dynamically
 *   linked child process.
 * - `DYLD_INSERT_LIBRARIES` / `DYLD_LIBRARY_PATH` — the macOS equivalents.
 * - `NODE_OPTIONS` — injects `--require`/`--import` into every node child.
 * - `PATH` — decides which `node`, `git`, `sh` and friends a run can reach.
 * - `HOME` — decides which `~/.zcode` (config, skills, credentials) a run
 *   reads, and therefore which instructions and keys it loads.
 */
export const PROTECTED_ENV_NAMES = [
  "ZCODE_SERVER_RUNTIME_ROOT",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "PATH",
  "HOME",
] as const;

export type ProtectedEnvName = (typeof PROTECTED_ENV_NAMES)[number];

/**
 * True when `name` is a protected environment variable name.
 *
 * Matching is case-sensitive and exact — see PROTECTED_ENV_NAMES.
 */
export function isProtectedEnvName(name: string): boolean {
  return (PROTECTED_ENV_NAMES as readonly string[]).includes(name);
}

/**
 * A configuration value the adapter refuses to act on.
 *
 * Thrown (not warned about) so that a rejected configuration fails the run
 * loudly instead of degrading into something that still executes.
 */
export class AdapterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConfigError";
  }
}

/**
 * Resolve the zcode permission mode — fail-CLOSED.
 *
 * Before this change an unknown mode silently fell back to `DEFAULT_MODE`,
 * which is `yolo`: the most permissive mode there is. A typo in the config
 * therefore *widened* the sandbox instead of narrowing it.
 *
 * Now an unrecognised non-empty value is an explicit error. Only an unset
 * mode (undefined / null / empty / whitespace) still resolves to
 * `DEFAULT_MODE`, which is the documented default behaviour.
 */
export function resolveMode(value: unknown): ZcodeMode {
  if (value === undefined || value === null) return DEFAULT_MODE;
  if (typeof value !== "string") {
    throw new AdapterConfigError(
      `mode must be one of ${ZCODE_MODES.join(", ")} (got ${typeof value}).`,
    );
  }
  const candidate = value.trim().toLowerCase();
  if (candidate.length === 0) return DEFAULT_MODE;
  if (!(ZCODE_MODES as readonly string[]).includes(candidate)) {
    throw new AdapterConfigError(
      `mode "${value}" is not a valid zcode mode; expected one of ${ZCODE_MODES.join(", ")}.`,
    );
  }
  return candidate as ZcodeMode;
}

/**
 * Validate the `ZCODE_SERVER_RUNTIME_ROOT` environment variable.
 *
 * Chosen policy: FAIL-CLOSED — an invalid value is an explicit error, not a
 * silent fallback to `~/.zcode/server/node`. The variable exists to redirect
 * WHICH node binary runs the ZCode app bundle; a value that is relative or
 * contains a `..` segment is either an attack (traversal to an
 * attacker-controlled interpreter) or an operator mistake, and silently
 * ignoring it would run a different binary than the operator believes they
 * configured. Failing loudly is the only outcome that cannot surprise anyone.
 *
 * `..` is checked on the RAW value, before normalisation: `path.normalize()`
 * would collapse `/a/b/../c` into `/a/c` and hide the traversal.
 */
export function assertSafeRuntimeRoot(raw: string): string {
  const root = raw.trim();
  if (root.length === 0) {
    throw new AdapterConfigError("ZCODE_SERVER_RUNTIME_ROOT is empty.");
  }
  if (!path.isAbsolute(root)) {
    throw new AdapterConfigError(
      `ZCODE_SERVER_RUNTIME_ROOT "${root}" must be an absolute path.`,
    );
  }
  const segments = root.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new AdapterConfigError(
      `ZCODE_SERVER_RUNTIME_ROOT "${root}" must not contain ".." path segments.`,
    );
  }
  return root;
}

/** True when the current process may execute `filePath` (X_OK). */
export function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the `zcodeCommand` adapter config value.
 *
 * The value used to be returned verbatim and handed to `spawn()`, which made
 * it the single most powerful config key in the adapter: whatever it pointed
 * at was executed as the agent. It is now validated:
 *
 * - a path-shaped value must be ABSOLUTE, must EXIST, must be a FILE (a
 *   directory is rejected) and must be EXECUTABLE;
 * - a bare command name is only accepted when it is the documented default
 *   (`zcode`, resolved from `PATH` by the host) — a bare name is never joined
 *   onto a working directory, and never treated as a path;
 * - any other value is an explicit error. There is no silent fallback to
 *   `zcode`: a rejected command must not quietly become a different command.
 */
export function validateZcodeCommand(rawCommand: string): string {
  const command = rawCommand.trim();
  if (command.length === 0) {
    throw new AdapterConfigError("zcodeCommand is empty.");
  }

  const looksLikePath = command.includes("/") || command.includes("\\");
  if (!looksLikePath) {
    if (command !== DEFAULT_ZCODE_COMMAND) {
      throw new AdapterConfigError(
        `zcodeCommand "${command}" is not an absolute path. Only "${DEFAULT_ZCODE_COMMAND}" may be given as a bare command name; ` +
          `point zcodeCommand at the absolute path of a zcode binary instead.`,
      );
    }
    // Bare default command name: resolved from PATH by the host, exactly like
    // the documented DEFAULT_ZCODE_COMMAND semantics. Never joined as a path.
    return command;
  }

  if (!path.isAbsolute(command)) {
    throw new AdapterConfigError(
      `zcodeCommand "${command}" must be an absolute path (relative paths are rejected).`,
    );
  }
  if (!existsSync(command)) {
    throw new AdapterConfigError(`zcodeCommand "${command}" does not exist.`);
  }

  let stats;
  try {
    stats = statSync(command);
  } catch {
    throw new AdapterConfigError(`zcodeCommand "${command}" cannot be inspected.`);
  }
  if (!stats.isFile()) {
    throw new AdapterConfigError(`zcodeCommand "${command}" is not a file (directories are rejected).`);
  }
  if (!isExecutable(command)) {
    throw new AdapterConfigError(`zcodeCommand "${command}" is not executable.`);
  }
  return command;
}
