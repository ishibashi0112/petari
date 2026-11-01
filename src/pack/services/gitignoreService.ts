/**
 * .gitignore / .repomixignore の評価(Repomix エクスポート用)。
 *
 * 本家 repomix と同様に、ignore ファイルへ一致するファイルを
 * エクスポート対象から除外するための判定を行う。
 * パターンの照合は gitignoreMatcher.ts(git の gitignore(5) の規則の自前実装。実行時依存ゼロのため)。
 *
 * 探索範囲:
 * - 対象ファイルのディレクトリから上位へ ignore ファイルを収集する
 * - `.git` があるディレクトリ(リポジトリルート)で探索を打ち切る
 * - `.git` が見つからない場合は、基準ディレクトリ(.sln / .vbproj の場所)
 *   配下の ignore ファイルのみ適用する(無関係な上位フォルダの巻き込み防止)
 * - 近い ignore ファイルほど優先し、`!` による除外解除にも対応(git の仕様)
 *
 * ファイルシステムは deps 注入とし、単体テスト可能に保つ。
 */

import * as path from "node:path";
import { GitignoreRules } from "./gitignoreMatcher.ts";

export interface GitignoreDeps {
  /** ファイルを読む(存在しなければ undefined) */
  readTextFileIfExists(absolutePath: string): string | undefined;
  directoryExists(absolutePath: string): boolean;
}

/** 対象とする ignore ファイル名(本家 repomix と同じ組) */
const IGNORE_FILE_NAMES = [".gitignore", ".repomixignore"];

/** 上方向探索の上限(異常なパス構造での無限ループ防止) */
const MAX_WALK_UP = 64;

interface DirIgnore {
  directory: string;
  matcher: GitignoreRules;
  /** 根拠として表示する ignore ファイルのパス */
  sourceFiles: string;
}

function cacheKey(directory: string): string {
  return directory.toLowerCase();
}

/** child が base 配下(base 自身を含む)かどうか(大文字小文字は無視) */
function isWithin(base: string, child: string): boolean {
  const rel = path.relative(base.toLowerCase(), child.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 照合用の相対 POSIX パスへ変換(範囲外なら undefined) */
function toPosixRelative(fromDir: string, filePath: string): string | undefined {
  const rel = path.relative(fromDir, filePath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(path.sep).join("/");
}

export class GitignoreEvaluator {
  private readonly dirCache = new Map<string, DirIgnore | undefined>();
  private readonly chainCache = new Map<string, DirIgnore[]>();
  private readonly deps: GitignoreDeps;
  /** .sln / .vbproj のあるディレクトリ(.git 不在時の探索境界) */
  private readonly baseDir: string;

  constructor(deps: GitignoreDeps, baseDir: string) {
    this.deps = deps;
    this.baseDir = baseDir;
  }

  /**
   * ファイルが ignore 対象なら、根拠となった ignore ファイルのパスを返す。
   * 対象外なら undefined。
   */
  ignoreReasonFor(absoluteFilePath: string): string | undefined {
    const chain = this.chainFor(path.dirname(absoluteFilePath));
    // 近い ignore ファイルの判定を優先する(git の仕様に合わせる)
    for (const entry of chain) {
      const rel = toPosixRelative(entry.directory, absoluteFilePath);
      if (rel === undefined) {
        continue;
      }
      const verdict = entry.matcher.test(rel);
      if (verdict.unignored) {
        return undefined;
      }
      if (verdict.ignored) {
        return entry.sourceFiles;
      }
    }
    return undefined;
  }

  /** ディレクトリから上方向へ、適用すべき ignore ファイルを近い順に集める */
  private chainFor(fileDir: string): DirIgnore[] {
    const key = cacheKey(fileDir);
    const cached = this.chainCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const directories: string[] = [];
    let repoRootFound = false;
    let current = fileDir;
    for (let depth = 0; depth < MAX_WALK_UP; depth++) {
      directories.push(current);
      if (this.deps.directoryExists(path.join(current, ".git"))) {
        repoRootFound = true;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    // .git が無い場合は基準ディレクトリ配下のみを対象にする
    const effective = repoRootFound
      ? directories
      : directories.filter((dir) => isWithin(this.baseDir, dir));

    const chain: DirIgnore[] = [];
    for (const dir of effective) {
      const entry = this.dirIgnoreOf(dir);
      if (entry !== undefined) {
        chain.push(entry);
      }
    }
    this.chainCache.set(key, chain);
    return chain;
  }

  /** 1 ディレクトリ分の ignore ファイルを読み、マッチャーを作る(キャッシュ付き) */
  private dirIgnoreOf(directory: string): DirIgnore | undefined {
    const key = cacheKey(directory);
    if (this.dirCache.has(key)) {
      return this.dirCache.get(key);
    }
    let content = "";
    const sources: string[] = [];
    for (const name of IGNORE_FILE_NAMES) {
      const filePath = path.join(directory, name);
      const text = this.deps.readTextFileIfExists(filePath);
      if (text !== undefined) {
        content += `${text}\n`;
        sources.push(filePath);
      }
    }
    const entry: DirIgnore | undefined =
      content.trim() === ""
        ? undefined
        : {
            directory,
            matcher: new GitignoreRules(content),
            sourceFiles: sources.join(", "),
          };
    this.dirCache.set(key, entry);
    return entry;
  }
}
