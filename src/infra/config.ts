import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NewFileConfig } from "../core/applier.ts";

/** .petari/config.json (§10) */
export interface PetariConfig {
  downloadsDir: string | null;
  newFile: NewFileConfig;
  historyLimit: number | null;
  vscodeCommand: string;
}

export const DEFAULT_CONFIG: PetariConfig = {
  downloadsDir: null,
  newFile: { encoding: "utf8", eol: "lf" },
  historyLimit: null,
  vscodeCommand: "code",
};

/** グローバル設定のパス (§10)。Windows は %APPDATA%、他は XDG (~/.config) */
export function globalConfigPath(): string {
  if (process.platform === "win32" && process.env["APPDATA"] !== undefined) {
    return join(process.env["APPDATA"], "petari", "config.json");
  }
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "petari", "config.json");
}

function readConfigFile(path: string): Partial<PetariConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<PetariConfig>;
  } catch (e) {
    throw new Error(
      `${path} を JSON として読めません: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 既定 < グローバル < プロジェクトの順でマージする (プロジェクト優先・§10) */
export function loadConfig(root: string): PetariConfig {
  const global = readConfigFile(globalConfigPath());
  const project = readConfigFile(join(root, ".petari", "config.json"));
  return {
    ...DEFAULT_CONFIG,
    ...global,
    ...project,
    newFile: {
      ...DEFAULT_CONFIG.newFile,
      ...(global.newFile ?? {}),
      ...(project.newFile ?? {}),
    },
  };
}
