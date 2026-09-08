import type { CreateConfigValues } from "@paperclipai/adapter-utils";

/**
 * Maps the generic Paperclip agent-creation form values onto the
 * zcode_local adapter config shape consumed by execute()/testEnvironment().
 */
export function buildConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = { cwd: values.cwd };
  if (values.command?.trim()) config["zcodeCommand"] = values.command.trim();
  if (values.promptTemplate?.trim()) config["promptTemplate"] = values.promptTemplate;
  if (values.instructionsFilePath?.trim()) config["instructionsFilePath"] = values.instructionsFilePath.trim();
  if (values.extraArgs?.trim()) config["extraArgs"] = values.extraArgs.trim();
  if (values.envVars?.trim()) config["envVars"] = values.envVars.trim();
  return config;
}
