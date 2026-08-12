/**
 * OS 既定ブラウザで URL / ファイルを開く (§4.3 ブラウザ差分ビュー)。
 * 依存ゼロ方針のため OS コマンドを呼び出す (常に execFile の配列引数・シェル非経由)。
 * 対象は自前で生成した URL (http://127.0.0.1:...) か一時ファイルのパスのみで
 * 外部入力は渡さないが、Windows の引用は clipboard.ts と同じ単一引用符方式で行う。
 * 自動テストなし (実機確認のみ — clipboard.ts と同方針)。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** 既定ブラウザで開く。失敗時は throw (呼び出し側がパス/URL を案内して続行する) */
export async function openInBrowser(target: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileP("open", [target]);
    return;
  }
  if (process.platform === "win32") {
    // ' は '' にエスケープした単一引用符リテラルで渡す (展開・注入が起きない)
    const quoted = `'${target.replaceAll("'", "''")}'`;
    await execFileP("powershell", ["-NoProfile", "-Command", `Start-Process ${quoted}`]);
    return;
  }
  await execFileP("xdg-open", [target]);
}
