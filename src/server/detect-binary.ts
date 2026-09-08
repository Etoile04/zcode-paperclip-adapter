import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ResolvedZcodeBinary {
  command: string;
  args: string[];
  source: string;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimeNode(env: NodeJS.ProcessEnv): string {
  const runtimeRoot = env["ZCODE_SERVER_RUNTIME_ROOT"];
  const bundled = runtimeRoot
    ? path.join(runtimeRoot, "node")
    : path.join(homedir(), ".zcode", "server", "node");
  if (isFile(bundled)) return bundled;
  return "node";
}

/**
 * Resolution order for the zcode executable:
 * 1. explicit `zcodeCommand` adapter config
 * 2. the shim deployed by ZCode Desktop at ~/.zcode/server/agents/glm/zcode-agent
 * 3. the app-bundled zcode.cjs run through node
 * 4. `zcode` on PATH (caller decides; runChildProcess will surface the error)
 */
export function resolveZcodeBinary(
  configCommand: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedZcodeBinary | null {
  if (configCommand && configCommand.trim()) {
    return { command: configCommand.trim(), args: [], source: "adapter config (zcodeCommand)" };
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
