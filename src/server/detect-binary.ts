import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { assertSafeRuntimeRoot, isExecutable, validateZcodeCommand } from "./security.js";

export interface ResolvedZcodeBinary {
  command: string;
  args: string[];
  source: string;
}

function isFile(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the `node` binary that runs the ZCode app bundle.
 *
 * `ZCODE_SERVER_RUNTIME_ROOT` selects the directory holding that binary. It
 * is validated before use (absolute path, no `..` segment) and a rejected
 * value raises an explicit error instead of being ignored — see
 * `assertSafeRuntimeRoot()` for why the chosen policy is fail-closed.
 */
export function resolveRuntimeNode(env: NodeJS.ProcessEnv): string {
  const runtimeRoot = env["ZCODE_SERVER_RUNTIME_ROOT"];
  const bundled =
    runtimeRoot && runtimeRoot.trim().length > 0
      ? path.join(assertSafeRuntimeRoot(runtimeRoot), "node")
      : path.join(homedir(), ".zcode", "server", "node");
  if (isFile(bundled)) return bundled;
  return "node";
}

/**
 * Resolution order for the zcode executable:
 * 1. explicit `zcodeCommand` adapter config (validated — see
 *    `validateZcodeCommand()`)
 * 2. the shim deployed by ZCode Desktop at ~/.zcode/server/agents/glm/zcode-agent
 * 3. the app-bundled zcode.cjs run through node
 * 4. `zcode` on PATH (caller decides; runChildProcess will surface the error)
 *
 * An invalid `zcodeCommand` throws `AdapterConfigError`: it is never silently
 * ignored, and it never degrades into a different command.
 */
export function resolveZcodeBinary(
  configCommand: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedZcodeBinary | null {
  if (configCommand && configCommand.trim()) {
    const command = validateZcodeCommand(configCommand);
    return { command, args: [], source: "adapter config (zcodeCommand)" };
  }

  const shim = path.join(homedir(), ".zcode", "server", "agents", "glm", "zcode-agent");
  if (isExecutable(shim)) {
    return { command: shim, args: [], source: `ZCode Desktop shim (${shim})` };
  }

  const bundle = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
  if (isFile(bundle)) {
    return { command: resolveRuntimeNode(env), args: [bundle], source: `ZCode Desktop bundle via node (${bundle})` };
  }

  return null;
}
