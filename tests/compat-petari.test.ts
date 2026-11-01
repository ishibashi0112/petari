/**
 * compat/petari (npm の petari 0.15.0〜。tazuna を呼ぶだけの互換コマンド) の確認。
 * 起動の確認は、node_modules に petari と偽の tazuna を置いた一時ディレクトリで行う。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planForward } from "../compat/petari/forward.js";

const COMPAT_DIR = join(import.meta.dirname, "..", "compat", "petari");

describe("compat/petari: planForward", () => {
  it("引数はそのまま tazuna に渡し、改名を知らせる", () => {
    const plan = planForward(["watch", "--root", "C:\\work"]);
    expect(plan).toEqual({
      kind: "run",
      args: ["watch", "--root", "C:\\work"],
      notice: "[petari] petari は tazuna に改名しました。同じ処理を npx tazuna watch で実行します(今後は npx tazuna watch を使ってください)。",
    });
  });

  it("適用 (サブコマンドなし) の案内は npx tazuna", () => {
    const plan = planForward(["changes.md", "--yes"]);
    expect(plan.kind === "run" && plan.notice.includes("npx tazuna で実行します")).toBe(true);
    expect(planForward([])).toMatchObject({ kind: "run", args: [] });
  });

  it("-v / --version は自分で答える (pack の後ろのものは pack に渡す。tazuna と同じ)", () => {
    expect(planForward(["-v"])).toEqual({ kind: "version" });
    expect(planForward(["undo", "--version"])).toEqual({ kind: "version" });
    expect(planForward(["pack", "-v"])).toMatchObject({ kind: "run", args: ["pack", "-v"] });
  });

  it("パッケージは tazuna だけに依存し、bin は petari", () => {
    const pkg = JSON.parse(readFileSync(join(COMPAT_DIR, "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
      files: string[];
    };
    const own = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(pkg.name).toBe("petari");
    expect(pkg.bin).toEqual({ petari: "./cli.js" });
    expect(Object.keys(pkg.dependencies)).toEqual([own.name]);
    expect(pkg.dependencies[own.name]).toBe(`^${own.version}`);
    expect(pkg.files).toEqual(["cli.js", "forward.js"]);
  });
});

describe("compat/petari: 起動", () => {
  /** node_modules/petari (このパッケージ) と、受け取った引数を出して 3 で終わる偽の tazuna */
  function install(): string {
    const dir = mkdtempSync(join(tmpdir(), "tazuna-compat-"));
    const petari = join(dir, "node_modules", "petari");
    const tazuna = join(dir, "node_modules", "tazuna");
    mkdirSync(petari, { recursive: true });
    mkdirSync(join(tazuna, "dist"), { recursive: true });
    for (const file of ["cli.js", "forward.js", "package.json"]) {
      copyFileSync(join(COMPAT_DIR, file), join(petari, file));
    }
    writeFileSync(
      join(tazuna, "package.json"),
      JSON.stringify({ name: "tazuna", version: "9.9.9", type: "module", bin: { tazuna: "./dist/cli.js" } }),
    );
    writeFileSync(
      join(tazuna, "dist", "cli.js"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = 3;\n",
    );
    return petari;
  }

  it("引数を配列のまま tazuna に渡し、終了コードは tazuna のもの", () => {
    const petari = install();
    const result = spawnSync(process.execPath, [join(petari, "cli.js"), "watch", "a b", "$(echo x)"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual(["watch", "a b", "$(echo x)"]);
    expect(result.stderr).toContain("petari は tazuna に改名しました");
  });

  it("--version は自分の版と呼び先の版", () => {
    const petari = install();
    const result = spawnSync(process.execPath, [join(petari, "cli.js"), "--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.15.0(tazuna 9.9.9 を呼びます)\n");
    expect(result.stderr).toBe("");
  });
});
