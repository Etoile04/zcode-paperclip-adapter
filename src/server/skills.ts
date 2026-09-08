/**
 * Skills integration for the zcode runtime.
 *
 * The host passes Paperclip-managed skill entries via `config.paperclipRuntimeSkills`
 * (source directories on disk) and the agent's selection via
 * `config.paperclipSkillSync.desiredSkills`. ZCode discovers user skills from
 * ~/.agents/skills/, so desired Paperclip skills are injected as symlinks there
 * (never overwriting a real directory) — the same pattern claude_local uses for
 * ~/.claude/skills and codex_local for ~/.codex/skills.
 */
// Structural mirrors of the in-repo adapter-utils skill types (not yet in the
// npm-published @paperclipai/adapter-utils).
export type AdapterSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export interface AdapterSkillEntry {
  key: string;
  runtimeName: string | null;
  versionId?: string | null;
  currentVersionId?: string | null;
  desired: boolean;
  managed: boolean;
  state: AdapterSkillState;
  origin?: "company_managed" | "user_installed" | "external_unknown";
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

export interface AdapterSkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: "unsupported" | "persistent" | "ephemeral";
  desiredSkills: string[];
  desiredSkillEntries?: Array<{ key: string; versionId: string | null }>;
  entries: AdapterSkillEntry[];
  warnings: string[];
}

export interface AdapterSkillContext {
  agentId: string;
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTER_TYPE } from "../shared/constants.js";

export const ZCODE_SKILLS_HOME = path.join(os.homedir(), ".agents", "skills");

interface RuntimeSkillSource {
  key: string;
  runtimeName: string;
  source: string;
  versionId: string | null;
  currentVersionId: string | null;
}

function normalizeRuntimeSkillSources(value: unknown): RuntimeSkillSource[] {
  if (!Array.isArray(value)) return [];
  const entries: RuntimeSkillSource[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const key = typeof record["key"] === "string" ? record["key"].trim() : "";
    const source = typeof record["source"] === "string" ? record["source"].trim() : "";
    if (!key || !source) continue;
    entries.push({
      key,
      runtimeName:
        typeof record["runtimeName"] === "string" && record["runtimeName"].trim()
          ? record["runtimeName"].trim()
          : key,
      source,
      versionId: typeof record["versionId"] === "string" ? record["versionId"] : null,
      currentVersionId: typeof record["currentVersionId"] === "string" ? record["currentVersionId"] : null,
    });
  }
  return entries;
}

function readDesiredSkillKeys(config: Record<string, unknown>): { explicit: boolean; keys: string[] } {
  const raw = config["paperclipSkillSync"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, keys: [] };
  }
  const desiredValues = (raw as Record<string, unknown>)["desiredSkills"];
  if (!Array.isArray(desiredValues)) return { explicit: false, keys: [] };
  const keys = desiredValues
    .map((value) => {
      if (typeof value === "string") return value.trim();
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const key = (value as Record<string, unknown>)["key"];
        return typeof key === "string" ? key.trim() : "";
      }
      return "";
    })
    .filter(Boolean);
  return { explicit: true, keys: Array.from(new Set(keys)) };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isSymlinkTo(target: string, sourceDir: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(target);
    if (!stat.isSymbolicLink()) return false;
    const resolved = await fs.promises.realpath(target);
    const source = await fs.promises.realpath(sourceDir);
    return resolved === source;
  } catch {
    return false;
  }
}

/** Scan zcode's global skills dir (~/.agents/skills) for user-installed skills. */
async function scanZcodeUserSkills(): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];
  let dirs: fs.Dirent[] = [];
  try {
    dirs = await fs.promises.readdir(ZCODE_SKILLS_HOME, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const skillMd = path.join(ZCODE_SKILLS_HOME, dir.name, "SKILL.md");
    if (!(await pathExists(skillMd))) continue;
    entries.push({
      key: dir.name,
      runtimeName: dir.name,
      desired: false,
      managed: false,
      state: "installed",
      origin: "user_installed",
      originLabel: "zcode user skill",
      locationLabel: `~/.agents/skills/${dir.name}`,
      readOnly: true,
      sourcePath: path.join(ZCODE_SKILLS_HOME, dir.name),
      targetPath: null,
      detail: null,
    });
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Ensure the desired Paperclip skills are symlinked into ~/.agents/skills.
 * Safe to call on every run: existing correct symlinks are kept, foreign
 * directories are never touched, stale paperclip symlinks are removed.
 */
export async function ensureZcodeSkillsSynced(config: Record<string, unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const sources = normalizeRuntimeSkillSources(config["paperclipRuntimeSkills"]);
  if (sources.length === 0) return warnings;
  const { explicit, keys } = readDesiredSkillKeys(config);
  if (!explicit) return warnings;
  const desiredKeys = new Set(keys);
  const ownedSources = new Set(sources.map((entry) => entry.source));

  await fs.promises.mkdir(ZCODE_SKILLS_HOME, { recursive: true });
  const existing = new Set(
    (await fs.promises.readdir(ZCODE_SKILLS_HOME).catch(() => [] as string[])).map((name) => name),
  );

  for (const entry of sources) {
    const desired = desiredKeys.has(entry.key);
    const target = path.join(ZCODE_SKILLS_HOME, entry.runtimeName);
    if (desired) {
      if (existing.has(entry.runtimeName)) {
        if (await isSymlinkTo(target, entry.source)) continue; // already correct
        warnings.push(
          `Skill "${entry.runtimeName}" already exists in ~/.agents/skills as a non-Paperclip entry; not overwritten.`,
        );
        continue;
      }
      if (!(await pathExists(path.join(entry.source, "SKILL.md")))) {
        warnings.push(`Skill source for "${entry.key}" has no SKILL.md at ${entry.source}.`);
        continue;
      }
      try {
        await fs.promises.symlink(entry.source, target, "dir");
      } catch (err) {
        warnings.push(`Failed to link skill "${entry.runtimeName}": ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (existing.has(entry.runtimeName)) {
      // Remove only symlinks this adapter previously created.
      if (await isSymlinkTo(target, entry.source)) {
        await fs.promises.unlink(target).catch(() => {});
      }
    }
    void ownedSources;
  }
  return warnings;
}

async function buildZcodeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const sources = normalizeRuntimeSkillSources(config["paperclipRuntimeSkills"]);
  const { keys } = readDesiredSkillKeys(config);
  const desiredKeys = new Set(keys);

  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  for (const entry of sources) {
    const desired = desiredKeys.has(entry.key);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      versionId: entry.versionId,
      currentVersionId: entry.currentVersionId,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: "company_managed",
      originLabel: "Managed by Paperclip",
      locationLabel: `~/.agents/skills/${entry.runtimeName}`,
      readOnly: false,
      sourcePath: entry.source,
      targetPath: path.join(ZCODE_SKILLS_HOME, entry.runtimeName),
      detail: desired
        ? "Symlinked into ~/.agents/skills; zcode discovers it automatically on the next run."
        : null,
    });
  }

  const sourceKeys = new Set(sources.map((entry) => entry.key));
  for (const userEntry of await scanZcodeUserSkills()) {
    if (sourceKeys.has(userEntry.key)) continue;
    entries.push(userEntry);
  }

  for (const key of keys) {
    if (sourceKeys.has(key)) continue;
    warnings.push(`Desired skill "${key}" is not available in this Paperclip company.`);
    entries.push({
      key,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Not found in company skills.",
    });
  }

  return {
    adapterType: ADAPTER_TYPE,
    supported: true,
    mode: "persistent",
    desiredSkills: keys,
    entries: entries.sort((a, b) => a.key.localeCompare(b.key)),
    warnings,
  };
}

export async function listZcodeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildZcodeSkillSnapshot(ctx.config);
}

export async function syncZcodeSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  await ensureZcodeSkillsSynced(ctx.config);
  return buildZcodeSkillSnapshot(ctx.config);
}
