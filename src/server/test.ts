import {
  type AdapterEnvironmentCheck,
  type AdapterEnvironmentTestContext,
  type AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ADAPTER_TYPE } from "../shared/constants.js";
import { resolveZcodeBinary } from "./detect-binary.js";
import { AdapterConfigError } from "./security.js";

function statusFor(checks: AdapterEnvironmentCheck[]): "pass" | "warn" | "fail" {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function readUserConfig(): Record<string, unknown> | null {
  const configPath = path.join(homedir(), ".zcode", "cli", "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const cwd = asString(ctx.config["cwd"], "");

  if (cwd) {
    try {
      const stat = statSync(cwd);
      if (!stat.isDirectory()) {
        checks.push({
          code: "cwd_not_directory",
          level: "error",
          message: `Working directory is not a directory: ${cwd}`,
        });
      }
    } catch {
      checks.push({
        code: "cwd_missing",
        level: "error",
        message: `Working directory does not exist: ${cwd}`,
        hint: "Create the directory or update the agent's cwd adapter config field.",
      });
    }
  } else {
    checks.push({
      code: "cwd_missing",
      level: "warn",
      message: "No working directory configured; zcode will run in the Paperclip server's cwd.",
      hint: "Set the cwd field in the agent's adapter config.",
    });
  }

  const zcodeCommand = asString(ctx.config["zcodeCommand"], "");
  let binary;
  try {
    binary = resolveZcodeBinary(zcodeCommand || undefined, process.env);
  } catch (error) {
    if (!(error instanceof AdapterConfigError)) throw error;
    checks.push({
      code: "zcode_command_invalid",
      level: "error",
      message: `zcodeCommand was rejected: ${error.message}`,
      hint: "Point zcodeCommand at the absolute path of an existing, executable zcode binary.",
    });
  }
  if (binary) {
    checks.push({
      code: "zcode_resolved",
      level: "info",
      message: `zcode binary resolved from ${binary.source}`,
      detail: binary.args.length > 0 ? `${binary.command} ${binary.args.join(" ")}` : binary.command,
    });
  } else {
    checks.push({
      code: "zcode_not_found",
      level: "error",
      message: "Could not find the zcode executable (no zcodeCommand set, no ZCode Desktop install found).",
      hint: "Install ZCode Desktop (macOS), or set the zcodeCommand adapter config field to the zcode/zcode-agent binary path.",
    });
  }

  const userConfig = readUserConfig();
  if (userConfig === null) {
    checks.push({
      code: "zcode_config_missing",
      level: "error",
      message: `~/.zcode/cli/config.json not found or unreadable; headless zcode requires an explicit model provider.`,
      hint: 'Open ZCode Desktop and configure a model, or create ~/.zcode/cli/config.json with {"model": "<provider>/<modelId>", "provider": {...}} (see the adapter README).',
    });
  } else {
    const model = userConfig["model"];
    if (typeof model === "string" && model.length > 0) {
      checks.push({
        code: "zcode_model_ok",
        level: "info",
        message: `zcode will use the model configured in ~/.zcode/cli/config.json (${model}).`,
      });
    } else if (typeof model === "object" && model !== null) {
      checks.push({
        code: "zcode_model_ok",
        level: "info",
        message: "zcode will use the model configured in ~/.zcode/cli/config.json.",
      });
    } else {
      checks.push({
        code: "zcode_model_missing",
        level: "error",
        message: "~/.zcode/cli/config.json has no \"model\" field; headless zcode exits with \"Model config is missing\".",
        hint: 'Add "model": "<providerId>/<modelId>" (e.g. "builtin:bigmodel-coding-plan/GLM-5.3") plus the matching "provider" entry. See the adapter README.',
      });
    }
  }

  return {
    adapterType: ADAPTER_TYPE,
    status: statusFor(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
