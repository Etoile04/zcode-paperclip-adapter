import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimeNode, resolveZcodeBinary } from "../src/server/detect-binary.js";
import { buildChildEnv, execute } from "../src/server/execute.js";
import {
  AdapterConfigError,
  PROTECTED_ENV_NAMES,
  isProtectedEnvName,
  resolveMode,
  validateZcodeCommand,
} from "../src/server/security.js";

/**
 * Adapter-side defence in depth (NFMA-540, L2).
 *
 * Every guard in this file must be removable: if a check is deleted from the
 * implementation, the matching case here must turn red. The negative-control
 * procedure that proves this is recorded in the ticket verdict; the cases
 * themselves are written so that they assert the REJECTION, not merely the
 * absence of an exception.
 */

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nfma540-"));
const executableFile = path.join(fixtureRoot, "zcode-bin");
const nonExecutableFile = path.join(fixtureRoot, "zcode-plain");
const directoryPath = path.join(fixtureRoot, "zcode-dir");
const runtimeRoot = path.join(fixtureRoot, "runtime-root");

writeFileSync(executableFile, "#!/bin/sh\nexit 0\n");
chmodSync(executableFile, 0o755);
writeFileSync(nonExecutableFile, "not executable\n");
chmodSync(nonExecutableFile, 0o644);
mkdirSync(directoryPath);
mkdirSync(runtimeRoot);
writeFileSync(path.join(runtimeRoot, "node"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(runtimeRoot, "node"), 0o755);

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run_nfma540",
    agent: {
      id: "agent_nfma540",
      companyId: "company_nfma540",
      name: "NFMA-540 Agent",
      adapterType: "zcode_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

describe("AC-1 · zcodeCommand is validated before it is executed", () => {
  // Each case asserts the SPECIFIC rejection, not merely "an error was
  // thrown": otherwise removing one check would let a different check reject
  // the same input and the suite would stay green.
  it("rejects a relative path", () => {
    expect(() => validateZcodeCommand("./zcode")).toThrow(/must be an absolute path/);
    expect(() => validateZcodeCommand("zcode/../zcode")).toThrow(/must be an absolute path/);
  });

  it("rejects an absolute path that does not exist", () => {
    expect(() => validateZcodeCommand(path.join(fixtureRoot, "nope"))).toThrow(/does not exist/);
  });

  it("rejects a file that is not executable", () => {
    expect(() => validateZcodeCommand(nonExecutableFile)).toThrow(/is not executable/);
  });

  it("rejects a directory", () => {
    expect(() => validateZcodeCommand(directoryPath)).toThrow(/is not a file/);
  });

  it("rejects any bare command name other than the documented default", () => {
    // A bare name is never joined onto a working directory, and it is never
    // treated as a path: only "zcode" (DEFAULT_ZCODE_COMMAND) is allowed, and
    // it keeps its PATH-resolution semantics.
    expect(() => validateZcodeCommand("curl")).toThrow(/is not an absolute path/);
    expect(() => validateZcodeCommand("sh")).toThrow(/is not an absolute path/);
    expect(() => validateZcodeCommand("/bin/sh")).not.toThrow();
  });

  it("accepts an existing, executable file at an absolute path", () => {
    expect(validateZcodeCommand(executableFile)).toBe(executableFile);
    const resolved = resolveZcodeBinary(executableFile, {});
    expect(resolved?.command).toBe(executableFile);
    expect(resolved?.source).toBe("adapter config (zcodeCommand)");
  });

  it("keeps the bare default command name as a name, not a path", () => {
    const resolved = resolveZcodeBinary("zcode", {});
    expect(resolved?.command).toBe("zcode");
    expect(path.isAbsolute(resolved?.command ?? "")).toBe(false);
  });

  it("never falls back to another binary when the configured command is invalid", () => {
    // The pre-fix behaviour returned the invalid value verbatim, and an
    // invalid value must never quietly become the Desktop shim either.
    expect(() => resolveZcodeBinary(path.join(fixtureRoot, "nope"), {})).toThrow(/does not exist/);
    expect(() => resolveZcodeBinary(directoryPath, {})).toThrow(/is not a file/);
    expect(() => resolveZcodeBinary("curl", {})).toThrow(/is not an absolute path/);
  });
});

describe("AC-2 · resolveRuntimeNode refuses a traversing runtime root", () => {
  it("rejects a runtime root containing a .. segment", () => {
    expect(() => resolveRuntimeNode({ ZCODE_SERVER_RUNTIME_ROOT: "/tmp/../etc" })).toThrow(
      /must not contain "\.\." path segments/,
    );
    // Built by concatenation on purpose: `path.join()` would normalise the
    // ".." away before the value ever reaches the guard, and the guard reads
    // the RAW value for exactly that reason.
    expect(() =>
      resolveRuntimeNode({ ZCODE_SERVER_RUNTIME_ROOT: `${runtimeRoot}/../elsewhere` }),
    ).toThrow(/must not contain "\.\." path segments/);
  });

  it("rejects a relative runtime root", () => {
    expect(() => resolveRuntimeNode({ ZCODE_SERVER_RUNTIME_ROOT: "runtime/root" })).toThrow(
      /must be an absolute path/,
    );
  });

  it("uses an absolute, traversal-free runtime root", () => {
    expect(resolveRuntimeNode({ ZCODE_SERVER_RUNTIME_ROOT: runtimeRoot })).toBe(
      path.join(runtimeRoot, "node"),
    );
  });

  it("falls back to the home directory when the variable is unset", () => {
    const resolved = resolveRuntimeNode({});
    expect([path.join(homedir(), ".zcode", "server", "node"), "node"]).toContain(resolved);
  });
});

describe("AC-3 · protected environment variables cannot be overridden by config", () => {
  const protectedNames = [...PROTECTED_ENV_NAMES];

  it("lists exactly the eight documented protected names", () => {
    expect(protectedNames.sort()).toEqual(
      [
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "HOME",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "NODE_OPTIONS",
        "PATH",
        "ZCODE_SERVER_RUNTIME_ROOT",
      ].sort(),
    );
  });

  it("matches protected names exactly (case-sensitive)", () => {
    expect(isProtectedEnvName("PATH")).toBe(true);
    expect(isProtectedEnvName("path")).toBe(false);
    expect(isProtectedEnvName("Node_Options")).toBe(false);
  });

  it("drops protected names supplied through envVars", () => {
    const { env, droppedEnvNames } = buildChildEnv(makeCtx(), {
      envVars: [
        "PATH=/tmp/evil-path",
        "HOME=/tmp/evil-home",
        "NODE_OPTIONS=--require /tmp/evil.js",
        "LD_PRELOAD=/tmp/evil.so",
        "LD_LIBRARY_PATH=/tmp/evil-libs",
        "DYLD_INSERT_LIBRARIES=/tmp/evil.dylib",
        "DYLD_LIBRARY_PATH=/tmp/evil-dylibs",
        "ZCODE_SERVER_RUNTIME_ROOT=/tmp/evil-root",
      ],
    });

    expect(env["PATH"]).not.toBe("/tmp/evil-path");
    expect(env["HOME"]).not.toBe("/tmp/evil-home");
    expect(env["NODE_OPTIONS"]).not.toBe("--require /tmp/evil.js");
    expect(env["LD_PRELOAD"]).not.toBe("/tmp/evil.so");
    expect(env["LD_LIBRARY_PATH"]).not.toBe("/tmp/evil-libs");
    expect(env["DYLD_INSERT_LIBRARIES"]).not.toBe("/tmp/evil.dylib");
    expect(env["DYLD_LIBRARY_PATH"]).not.toBe("/tmp/evil-dylibs");
    expect(env["ZCODE_SERVER_RUNTIME_ROOT"]).not.toBe("/tmp/evil-root");
    expect(droppedEnvNames.sort()).toEqual(protectedNames.sort());
  });

  it("drops protected names supplied through the env object", () => {
    const { env, droppedEnvNames } = buildChildEnv(makeCtx(), {
      env: { PATH: "/tmp/evil-path", HOME: "/tmp/evil-home", NODE_OPTIONS: "--require /tmp/evil.js" },
    });

    expect(env["PATH"]).not.toBe("/tmp/evil-path");
    expect(env["HOME"]).not.toBe("/tmp/evil-home");
    expect(env["NODE_OPTIONS"]).not.toBe("--require /tmp/evil.js");
    expect(droppedEnvNames.sort()).toEqual(["HOME", "NODE_OPTIONS", "PATH"]);
  });

  it("leaves the ambient PATH untouched and keeps ordinary variables", () => {
    const { env } = buildChildEnv(makeCtx(), {
      envVars: ["PATH=/tmp/evil-path", "NFMA540_ORDINARY=kept"],
    });

    expect(env["NFMA540_ORDINARY"]).toBe("kept");
    const ambientPath = process.env["PATH"];
    if (typeof ambientPath === "string") expect(env["PATH"]).toBe(ambientPath);
    expect(env["PATH"]).not.toBe("/tmp/evil-path");
  });

  it("does not treat a differently-cased name as protected", () => {
    // The process environment is case-sensitive on macOS and Linux, and the
    // consumers of these variables are case-sensitive too, so "path" is a
    // different variable that no loader reads.
    const { env, droppedEnvNames } = buildChildEnv(makeCtx(), { envVars: ["path=/tmp/lower"] });

    expect(env["path"]).toBe("/tmp/lower");
    expect(droppedEnvNames).toEqual([]);
  });
});

describe("AC-4 · resolveMode fails closed", () => {
  it("rejects a mode that is not a zcode mode", () => {
    expect(() => resolveMode("turbo")).toThrow(/is not a valid zcode mode/);
    expect(() => resolveMode("YOL0")).toThrow(/is not a valid zcode mode/);
    expect(() => resolveMode("yolo ")).not.toThrow();
  });

  it("rejects a non-string mode instead of silently defaulting", () => {
    expect(() => resolveMode(123)).toThrow(/mode must be one of/);
    expect(() => resolveMode({ mode: "plan" })).toThrow(/mode must be one of/);
  });

  it("keeps the documented default when no mode is configured", () => {
    expect(resolveMode(undefined)).toBe("yolo");
    expect(resolveMode(null)).toBe("yolo");
    expect(resolveMode("")).toBe("yolo");
    expect(resolveMode("   ")).toBe("yolo");
  });

  it("accepts every zcode mode", () => {
    expect(resolveMode("yolo")).toBe("yolo");
    expect(resolveMode("build")).toBe("build");
    expect(resolveMode("edit")).toBe("edit");
    expect(resolveMode("plan")).toBe("plan");
    expect(resolveMode("PLAN")).toBe("plan");
  });
});

describe("integration · a rejected configuration fails the run instead of spawning", () => {
  it("fails the run when zcodeCommand is invalid", async () => {
    const result = await execute(
      makeCtx({ config: { zcodeCommand: path.join(fixtureRoot, "nope") } }),
    );

    expect(result.errorCode).toBe("invalid_adapter_config");
    expect(result.exitCode).toBeNull();
    expect(result.errorMessage).toContain("zcode adapter configuration rejected");
  });

  it("fails the run when the mode is invalid", async () => {
    const result = await execute(makeCtx({ config: { mode: "turbo" } }));

    expect(result.errorCode).toBe("invalid_adapter_config");
    expect(result.errorMessage).toContain("is not a valid zcode mode");
  });
});
