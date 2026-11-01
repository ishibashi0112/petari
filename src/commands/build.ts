/**
 * petari build — MSBuild でビルドし、失敗したらエラーと今のファイルの周辺行を
 * Copilot Chat に貼れる文面にしてクリップボードへ入れる(旧 slnmix build。設計書 §22)。
 * 入力の決め方とルートはパックと同じ。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { BUILD_COMMAND } from "../brand.ts";
import { writeClipboardSync } from "../infra/clipboard.ts";
import { err } from "../infra/term.ts";
import { buildErrorReport, parseMsbuildErrors } from "../pack/buildErrors.ts";
import { locateMsbuild, runMsbuild, runVswhere } from "../pack/msbuildRunner.ts";
import { collectExtraRoots } from "../pack/services/extraRootsCollector.ts";
import { decodeSourceBuffer } from "../pack/services/repomixExporter.ts";
import { loadSlnmixConfig } from "../pack/slnmixConfig.ts";
import {
  createGitignoreEvaluator,
  FS_DEPS,
  isFilePath,
  readSourceTextFile,
  resolveTargetAndRoot,
} from "./pack-io.ts";

/** ログの末尾(エラーの行を取り出せなかったときに文面へ載せる分) */
const BUILD_LOG_TAIL_LINES = 40;

export function buildCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      msbuild: { type: "string" },
      configuration: { type: "string" },
      "no-clip": { type: "boolean", default: false },
      "no-mask": { type: "boolean", default: false },
      "no-strict-mask": { type: "boolean", default: false },
      "no-gitignore": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (positionals.length > 1) {
    err(`${BUILD_COMMAND} に渡せる入力は 1 つだけです。`);
    return 1;
  }
  const resolved = resolveTargetAndRoot(positionals[0], values.root, { legacyPaths: false });
  if (resolved.kind === "error") {
    err(resolved.message);
    return 1;
  }
  if (resolved.targetPath === undefined) {
    err(
      `${BUILD_COMMAND} は .sln / .vbproj の構成でのみ使えます(kind: "generic" のプロジェクトは、そのプロジェクトのビルド・テストのコマンドを使ってください)。`,
    );
    return 1;
  }
  return runBuild(resolved.targetPath, resolved.rootDir, {
    msbuild: values.msbuild,
    configuration: values.configuration,
    clip: !values["no-clip"],
    mask: values["no-mask"] ? undefined : { strict: !values["no-strict-mask"] },
    respectGitignore: !values["no-gitignore"],
  });
}

function runBuild(
  targetPath: string,
  rootDir: string,
  options: {
    msbuild: string | undefined;
    configuration: string | undefined;
    clip: boolean;
    mask: { strict: boolean } | undefined;
    /** .gitignore / .repomixignore を尊重するか(--no-gitignore で false) */
    respectGitignore: boolean;
  },
): number {
  const located = locateMsbuild(options.msbuild, {
    platform: process.platform,
    env: process.env,
    isFile: isFilePath,
    runVswhere,
  });
  if (located.kind === "error") {
    err(located.message);
    return 1;
  }
  err(`MSBuild: ${located.path}(${located.source})`);

  // エラーだけを UTF-8 のログに書かせる(コンソールのコードページに左右されない)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petari-build-"));
  try {
    const logFile = path.join(tempDir, "errors.log");
    const run = runMsbuild(located.path, targetPath, {
      ...(options.configuration !== undefined ? { configuration: options.configuration } : {}),
      logFile,
    });
    if (run.kind === "error") {
      err(`MSBuild を起動できませんでした: ${run.message}`);
      return 1;
    }
    if (run.status === 0) {
      err("ビルドに成功しました。");
      return 0;
    }
    const log = fs.existsSync(logFile) ? decodeSourceBuffer(fs.readFileSync(logFile)) : "";
    const errors = parseMsbuildErrors(log);
    if (errors.length === 0 && log.trim() === "") {
      err(
        `ビルドに失敗しました(終了コード ${run.status})。エラーの行を取り出せなかったので、上の MSBuild の出力を確認してください。`,
      );
      return 1;
    }
    const report = buildErrorReport(errors, log.split(/\r?\n/).slice(-BUILD_LOG_TAIL_LINES).join("\n"), {
      rootDir,
      ...(options.mask !== undefined ? { mask: options.mask } : {}),
      ...(options.respectGitignore
        ? {
            excludedBy: (() => {
              const gitignore = createGitignoreEvaluator(rootDir);
              return (absolutePath: string) => gitignore.ignoreReasonFor(absolutePath);
            })(),
          }
        : {}),
      // パックは追加ディレクトリ(extraRoots)から集めたファイルだけを汎用テキストとして伏せる(.vb も)。
      // 集め方はパックと同じ(include / exclude・常に除く場所)。.gitignore で除くファイルも数える
      // (除くときは抜粋を載せないため、数えても伏せすぎにならない)。走査は .vb のエラーがあるときだけ
      genericTextFor: (() => {
        const key = (p: string): string => {
          const resolved = path.resolve(p);
          return process.platform === "win32" ? resolved.toLowerCase() : resolved;
        };
        let files: Set<string> | undefined;
        return (absolutePath: string) => {
          if (files === undefined) {
            const roots = loadSlnmixConfig(rootDir, { readTextFile: readSourceTextFile }).config.extraRoots;
            const collected = collectExtraRoots(rootDir, roots, {
              listFilesRecursive: FS_DEPS.listFilesRecursive,
            });
            files = new Set(collected.files.map((f) => key(f.absolutePath)));
          }
          return files.has(key(absolutePath));
        };
      })(),
      readLines: (absolutePath) => {
        try {
          // CRLF / LF で分ける(伏せる処理をパックと同じ区切りの文字列にかけるため)。単独の CR などは
          // buildErrorReport がコンパイラーと同じ数え方で分ける
          const lines = decodeSourceBuffer(fs.readFileSync(absolutePath)).split(/\r?\n/);
          // 末尾の改行の後ろは行ではない
          if (lines.length > 1 && lines[lines.length - 1] === "") {
            lines.pop();
          }
          return lines;
        } catch {
          return undefined;
        }
      },
    });
    const count = errors.length === 0 ? "エラーのログ" : `エラー ${errors.length} 件と周辺のコード`;
    if (options.clip) {
      const clipped = writeClipboardSync(report);
      if (clipped.ok) {
        err(`ビルドに失敗しました。${count}をクリップボードにコピーしました → Copilot Chat の本文に貼って送信してください`);
        return 1;
      }
      err(`[warning] クリップボードにコピーできませんでした(${clipped.message})。文面を標準出力に出します`);
    }
    process.stdout.write(report);
    err(`ビルドに失敗しました。上の文面(${count})を Copilot Chat の本文に貼って送信してください`);
    return 1;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
