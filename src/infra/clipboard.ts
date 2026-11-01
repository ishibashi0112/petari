/**
 * クリップボード読み書き (§4.1 --clip, §7 --clip-report、パック・ビルドエラーの受け渡し)。
 * 依存ゼロ方針のため OS コマンドを呼び出す:
 *   macOS: pbpaste / pbcopy
 *   Windows: PowerShell Get-Clipboard / Set-Clipboard (UTF-8 の一時ファイル経由。コンソールのコードページに依存しない)
 *   Linux: xclip (インストールされている場合のみ)
 * 子プロセスは常に配列引数 (シェル非経由)。自動テストはなく実機で確認する。
 */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TOOL_NAME } from "../brand.ts";

const execFileP = promisify(execFile);

export type ClipboardResult = { ok: true } | { ok: false; message: string };

/** クリップボードのコマンドが固まっても全体を止めない */
const TIMEOUT_MS = 15_000;

function describeRun(result: ReturnType<typeof spawnSync>, command: string): ClipboardResult {
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      message: code === "ENOENT" ? `${command} が見つかりません` : result.error.message,
    };
  }
  if (result.status !== 0) {
    return { ok: false, message: `${command} が終了コード ${result.status ?? "不明"} で終了しました` };
  }
  return { ok: true };
}

/** クリップボードへ書く (失敗しても例外にせず理由を返す) */
export function writeClipboardSync(text: string): ClipboardResult {
  if (process.platform === "win32") {
    // パスは PowerShell の単一引用符で渡す (' は '' にエスケープ。展開・注入が起きない)
    const dir = mkdtempSync(join(tmpdir(), `${TOOL_NAME}-clip-`));
    const file = join(dir, "clip.txt");
    try {
      writeFileSync(file, text, "utf8");
      const quoted = `'${file.split("'").join("''")}'`;
      return describeRun(
        spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-Content -Raw -Encoding UTF8 -LiteralPath ${quoted} | Set-Clipboard`,
          ],
          { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, timeout: TIMEOUT_MS },
        ),
        "PowerShell",
      );
    } finally {
      // コードを含むため一時ファイルを残さない
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (process.platform === "darwin") {
    return describeRun(
      spawnSync("pbcopy", [], { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: TIMEOUT_MS }),
      "pbcopy",
    );
  }
  // xclip は選択を保持するため裏で常駐する。stdout / stderr をつなぐとその子が
  // 閉じるまで待ってしまうので、入力以外はつながない
  return describeRun(
    spawnSync("xclip", ["-selection", "clipboard"], {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: TIMEOUT_MS,
    }),
    "xclip",
  );
}

export async function readClipboard(): Promise<string> {
  if (process.platform === "darwin") {
    const { stdout } = await execFileP("pbpaste", []);
    return stdout;
  }
  if (process.platform === "win32") {
    const { stdout } = await execFileP("powershell", [
      "-NoProfile",
      "-Command",
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw",
    ]);
    return stdout;
  }
  const { stdout } = await execFileP("xclip", ["-selection", "clipboard", "-o"]);
  return stdout;
}

export async function writeClipboard(text: string): Promise<void> {
  const result = writeClipboardSync(text);
  if (!result.ok) throw new Error(result.message);
}
