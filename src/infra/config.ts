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
  /** 失敗レポート出力時にクリップボードへ自動コピーする (§7)。--clip-report は常に有効 */
  clipReportOnFailure: boolean;
}

export const DEFAULT_CONFIG: PetariConfig = {
  downloadsDir: null,
  newFile: { encoding: "utf8", eol: "lf" },
  historyLimit: null,
  vscodeCommand: "code",
  clipReportOnFailure: true,
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

/** JSON 由来の値は型注釈を素通りするため、使う前に実行時検証する */
function validateConfig(c: PetariConfig): PetariConfig {
  const enc: unknown = c.newFile.encoding;
  if (enc !== "utf8" && enc !== "shift_jis") {
    throw new Error(`config の newFile.encoding が不正です: ${String(enc)} ("utf8" | "shift_jis")`);
  }
  const eol: unknown = c.newFile.eol;
  if (eol !== "lf" && eol !== "crlf") {
    throw new Error(`config の newFile.eol が不正です: ${String(eol)} ("lf" | "crlf")`);
  }
  const limit: unknown = c.historyLimit;
  if (limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
    throw new Error(`config の historyLimit が不正です: ${String(limit)} (null または 1 以上の整数)`);
  }
  if (typeof c.vscodeCommand !== "string") {
    throw new Error("config の vscodeCommand が不正です (文字列を指定)");
  }
  if (c.downloadsDir !== null && typeof c.downloadsDir !== "string") {
    throw new Error("config の downloadsDir が不正です (null または文字列を指定)");
  }
  if (typeof c.clipReportOnFailure !== "boolean") {
    throw new Error("config の clipReportOnFailure が不正です (true | false)");
  }
  return c;
}

/** 既定 < グローバル < プロジェクトの順でマージする (プロジェクト優先・§10) */
export function loadConfig(root: string): PetariConfig {
  const global = readConfigFile(globalConfigPath());
  const project = readConfigFile(join(root, ".petari", "config.json"));
  return validateConfig({
    ...DEFAULT_CONFIG,
    ...global,
    ...project,
    newFile: {
      ...DEFAULT_CONFIG.newFile,
      ...(global.newFile ?? {}),
      ...(project.newFile ?? {}),
    },
  });
}
