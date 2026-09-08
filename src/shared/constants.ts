export const ADAPTER_TYPE = "zcode_local" as const;
export const ADAPTER_LABEL = "ZCode (local)";

export const DEFAULT_ZCODE_COMMAND = "zcode";
export const DEFAULT_MODE = "yolo";
export const ZCODE_MODES = ["yolo", "build", "edit", "plan"] as const;
export type ZcodeMode = (typeof ZCODE_MODES)[number];

export const DEFAULT_TIMEOUT_SEC = 1800;
export const MIN_TIMEOUT_SEC = 60;
export const MAX_TIMEOUT_SEC = 86400;
export const GRACE_SEC = 15;

export const ZCODE_MODELS = [
  { id: "GLM-5.3", label: "GLM-5.3 (default, reasoning)" },
  { id: "GLM-5.3-Flash", label: "GLM-5.3-Flash (fast)" },
  { id: "GLM-5-Turbo", label: "GLM-5-Turbo" },
] as const;
