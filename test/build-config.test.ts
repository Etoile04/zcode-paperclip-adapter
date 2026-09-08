import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/ui/build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function baseValues(overrides: Partial<CreateConfigValues>): CreateConfigValues {
  return {
    adapterType: "zcode_local",
    cwd: "/tmp/agent",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: true,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildConfig", () => {
  it("always carries cwd and omits empty optional fields", () => {
    expect(buildConfig(baseValues({}))).toEqual({ cwd: "/tmp/agent" });
  });

  it("maps the form fields onto adapter config keys", () => {
    const config = buildConfig(
      baseValues({
        command: "/usr/local/bin/zcode-agent",
        promptTemplate: "hi {{agentName}}",
        instructionsFilePath: "/tmp/instructions.md",
        extraArgs: "--verbose --locale en-US",
        envVars: "FOO=bar\nBAZ=qux",
      }),
    );
    expect(config).toEqual({
      cwd: "/tmp/agent",
      zcodeCommand: "/usr/local/bin/zcode-agent",
      promptTemplate: "hi {{agentName}}",
      instructionsFilePath: "/tmp/instructions.md",
      extraArgs: "--verbose --locale en-US",
      envVars: "FOO=bar\nBAZ=qux",
    });
  });
});
