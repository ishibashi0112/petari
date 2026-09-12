import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NewFileSetting } from "../core/new-file-style.ts";

/** .petari/config.json (§10) */
export interface PetariConfig {
  downloadsDir: string | null;
  /**
   * 新規ファイルの形式。encoding "auto" は作成先の既存ファイルから推定する (設計書 §11.2)。
   * eol / bom は省略可 (auto なら推定、それ以外は lf / BOM なし)
   */
  newFile: NewFileSetting;
  historyLimit: number | null;
  vscodeCommand: string;
  /** 失敗レポート出力時にクリップボードへ自動コピーする (§7)。--clip-report は常に有効 */
  clipReportOnFailure: boolean;
  /** create した .vb を旧スタイル .vbproj へ自動登録する (設計書 §11.1)。--no-vbproj で一時無効化 */
  vbproj: { register: boolean };
}

export const DEFAULT_CONFIG: PetariConfig = {
  downloadsDir: null,
  newFile: { encoding: "utf8", eol: "lf" },
  historyLimit: null,
  vscodeCommand: "code",
  clipReportOnFailure: true,
  vbproj: { register: true },
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
  if (enc !== "utf8" && enc !== "shift_jis" && enc !== "auto") {
    throw new Error(
      `config の newFile.encoding が不正です: ${String(enc)} ("utf8" | "shift_jis" | "auto")`,
    );
  }
  const eol: unknown = c.newFile.eol;
  if (eol !== undefined && eol !== "lf" && eol !== "crlf") {
    throw new Error(`config の newFile.eol が不正です: ${String(eol)} ("lf" | "crlf")`);
  }
  const bom: unknown = c.newFile.bom;
  if (bom !== undefined && typeof bom !== "boolean") {
    throw new Error(`config の newFile.bom が不正です: ${String(bom)} (true | false)`);
  }
  const register: unknown = c.vbproj?.register;
  if (typeof c.vbproj !== "object" || c.vbproj === null || typeof register !== "boolean") {
    throw new Error('config の vbproj が不正です ({ "register": true | false } を指定)');
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
    newFile: mergeNewFile(global.newFile, project.newFile),
    vbproj: {
      ...DEFAULT_CONFIG.vbproj,
      ...(global.vbproj ?? {}),
      ...(project.vbproj ?? {}),
    },
  });
}

/**
 * newFile の合成。encoding "auto" のときは既定の eol: "lf" / bom を混ぜない
 * (混ぜると eol / BOM の推定が効かなくなる)。ユーザーが明示した eol / bom は auto でも残る
 */
function mergeNewFile(
  global: Partial<NewFileSetting> | undefined,
  project: Partial<NewFileSetting> | undefined,
): NewFileSetting {
  const user = { ...(global ?? {}), ...(project ?? {}) };
  if (user.encoding === "auto") return user as NewFileSetting;
  return { ...DEFAULT_CONFIG.newFile, ...user };
}
