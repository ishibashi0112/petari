import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * 未コミット変更のあるファイル一覧 (§9)。
 * Git が使えない / リポジトリでない場合は null (Git は必須ではない)。
 */
export async function gitDirtyFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain"], { cwd: root });
    return stdout.split("\n").filter((l) => l.trim() !== "");
  } catch {
    return null;
  }
}
