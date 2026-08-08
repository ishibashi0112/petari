/**
 * ダウンロードフォルダの解決と changes*.md の自動検出 (§4.1, §10)。
 * Windows は Known Folder (レジストリ) から取得し、OneDrive リダイレクトされた
 * 社用 PC でも正しいフォルダを見つける。
 */
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Known Folder GUID: Downloads */
const DOWNLOADS_GUID = "{374DE290-123F-4565-9164-39C4925E467B}";
const USER_SHELL_FOLDERS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

/** %USERPROFILE% 等の Windows 環境変数参照を展開する */
export function expandWindowsEnv(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    return process.env[name] ?? process.env[name.toUpperCase()] ?? whole;
  });
}

/** `reg query ... /v {GUID}` の出力から値 (REG_EXPAND_SZ / REG_SZ) を取り出す */
export function parseRegQueryValue(stdout: string, guid: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.toUpperCase().includes(guid.toUpperCase())) continue;
    const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line);
    if (m !== null) return (m[1] as string).trim();
  }
  return null;
}

export async function resolveDownloadsDir(configured: string | null): Promise<string> {
  if (configured !== null && configured !== "") return configured;
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileP("reg", [
        "query",
        USER_SHELL_FOLDERS_KEY,
        "/v",
        DOWNLOADS_GUID,
      ]);
      const value = parseRegQueryValue(stdout, DOWNLOADS_GUID);
      if (value !== null) return expandWindowsEnv(value);
    } catch {
      // reg が使えない場合は既定にフォールバック
    }
  }
  return join(homedir(), "Downloads");
}

export interface CandidateFile {
  path: string;
  mtime: Date;
}

/**
 * changes*.md のうち更新が maxAgeMinutes 以内のものを新しい順に返す (§4.1)。
 * 古いファイルの誤適用を防ぐため、既定 30 分より古いものは対象外。
 */
export function findRecentChangesFiles(
  dir: string,
  now: Date,
  maxAgeMinutes = 30,
): CandidateFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: CandidateFile[] = [];
  for (const name of names) {
    if (!/^changes.*\.md$/i.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      if (now.getTime() - st.mtimeMs <= maxAgeMinutes * 60_000) {
        found.push({ path, mtime: st.mtime });
      }
    } catch {
      // 読めないファイルは無視
    }
  }
  return found.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}
