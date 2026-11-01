/**
 * `slnmix build` の MSBuild の場所の決定と起動(v0.20.0、設計書 §22)。
 *
 * 場所の優先順位: --msbuild > vswhere(VS 2017 以降・Build Tools)>
 * MSBuild 14.0 / 12.0(VS 2015 / 2013)> .NET Framework 4 の MSBuild。
 * 推測はせず、実在するファイルだけを使う。子プロセスは配列引数(シェル非経由)。
 * 場所の決定は deps 注入で単体テストし、起動は実機で確認する。
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

export interface MsbuildLocatorDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  isFile(absolutePath: string): boolean;
  /** vswhere を実行して標準出力を返す(起動できない・失敗したら undefined) */
  runVswhere(vswherePath: string, args: string[]): string | undefined;
}

export type MsbuildLocation =
  | { kind: "found"; path: string; source: string }
  | { kind: "error"; message: string };

const VSWHERE_ARGS = [
  "-latest",
  "-products",
  "*",
  "-requires",
  "Microsoft.Component.MSBuild",
  "-find",
  "MSBuild\\**\\Bin\\MSBuild.exe",
  "-utf8",
];

export function locateMsbuild(explicit: string | undefined, deps: MsbuildLocatorDeps): MsbuildLocation {
  if (explicit !== undefined && explicit !== "") {
    return { kind: "found", path: explicit, source: "--msbuild" };
  }
  if (deps.platform !== "win32") {
    return {
      kind: "error",
      message:
        "MSBuild の自動検出は Windows だけです。--msbuild で実行するコマンドを指定してください。",
    };
  }
  const win = path.win32;
  const programFilesX86 = deps.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const windir = deps.env["WINDIR"] ?? deps.env["windir"] ?? "C:\\Windows";
  const checked: string[] = [];

  const vswhere = win.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  checked.push(vswhere);
  if (deps.isFile(vswhere)) {
    const found = (deps.runVswhere(vswhere, VSWHERE_ARGS) ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "" && deps.isFile(line));
    if (found !== undefined) {
      return { kind: "found", path: found, source: "vswhere" };
    }
  }

  const fixed: [string, string][] = [
    [win.join(programFilesX86, "MSBuild", "14.0", "Bin", "MSBuild.exe"), "MSBuild 14.0(VS 2015)"],
    [win.join(programFilesX86, "MSBuild", "12.0", "Bin", "MSBuild.exe"), "MSBuild 12.0(VS 2013)"],
    [win.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "MSBuild.exe"), ".NET Framework 4"],
    [win.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "MSBuild.exe"), ".NET Framework 4"],
  ];
  for (const [candidate, source] of fixed) {
    checked.push(candidate);
    if (deps.isFile(candidate)) {
      return { kind: "found", path: candidate, source };
    }
  }
  return {
    kind: "error",
    message: [
      "MSBuild が見つかりませんでした。次の場所を確かめました:",
      ...checked.map((p) => `  ${p}`),
      "--msbuild で MSBuild.exe のパスを指定してください。",
    ].join("\n"),
  };
}

/** vswhere を起動する(既定の実装) */
export function runVswhere(vswherePath: string, args: string[]): string | undefined {
  const result = spawnSync(vswherePath, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return result.status === 0 ? result.stdout : undefined;
}

export interface MsbuildRunOptions {
  /** /p:Configuration に渡す値(省略時はソリューションの既定) */
  configuration?: string | undefined;
  /** エラーだけを UTF-8 で書くログファイル(コンソールのコードページに左右されない) */
  logFile: string;
}

export function msbuildArgs(target: string, options: MsbuildRunOptions): string[] {
  return [
    target,
    "/nologo",
    "/m",
    "/v:minimal",
    ...(options.configuration !== undefined ? [`/p:Configuration=${options.configuration}`] : []),
    "/fl",
    `/flp:LogFile=${options.logFile};ErrorsOnly;Encoding=UTF-8`,
  ];
}

export type MsbuildRunResult = { kind: "exited"; status: number } | { kind: "error"; message: string };

/** MSBuild を起動する。進行状況は利用者の端末にそのまま出す */
export function runMsbuild(msbuild: string, target: string, options: MsbuildRunOptions): MsbuildRunResult {
  const result = spawnSync(msbuild, msbuildArgs(target, options), { stdio: "inherit", windowsHide: true });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      kind: "error",
      message: code === "ENOENT" ? `${msbuild} が見つかりません` : result.error.message,
    };
  }
  return { kind: "exited", status: result.status ?? 1 };
}
