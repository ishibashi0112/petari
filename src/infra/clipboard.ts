/**
 * クリップボード読み書き (§4.1 --clip, §7 --clip-report)。
 * 依存ゼロ方針のため OS コマンドを呼び出す:
 *   macOS: pbpaste / pbcopy
 *   Windows: PowerShell Get-Clipboard / Set-Clipboard (UTF-8 経由)
 *   Linux: xclip (インストールされている場合のみ)
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

function viaStdin(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
    child.stdin.end(text, "utf8");
  });
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
  if (process.platform === "darwin") {
    await viaStdin("pbcopy", [], text);
    return;
  }
  if (process.platform === "win32") {
    // コンソールのコードページに依存しないよう UTF-8 の一時ファイル経由で渡す。
    // パスは PowerShell の単一引用符で渡す (' は '' にエスケープ。展開・注入が起きない)
    const dir = mkdtempSync(join(tmpdir(), "petari-clip-"));
    const file = join(dir, "report.txt");
    try {
      writeFileSync(file, text, "utf8");
      const quoted = `'${file.replaceAll("'", "''")}'`;
      await execFileP("powershell", [
        "-NoProfile",
        "-Command",
        `Get-Content -Raw -Encoding UTF8 -LiteralPath ${quoted} | Set-Clipboard`,
      ]);
    } finally {
      // レポートはコードの断片を含むため一時ファイルを残さない
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }
  await viaStdin("xclip", ["-selection", "clipboard"], text);
}
