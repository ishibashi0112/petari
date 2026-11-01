/**
 * extraRootsCollector の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import {
  collectExtraRoots,
  type ExtraRootsDeps,
} from "../../src/pack/services/extraRootsCollector.ts";
import { defaultIncludeFor, type ExtraRootConfig } from "../../src/pack/slnmixConfig.ts";

const ROOT = path.resolve("/work/repo");

function fakeDeps(
  filesByDir: Record<string, string[]>,
  ignored: string[] = [],
): ExtraRootsDeps {
  return {
    listFilesRecursive: (dir) => {
      const rel = path.relative(ROOT, dir).split(path.sep).join("/");
      const files = filesByDir[rel];
      return files?.map((f) => path.join(dir, ...f.split("/")));
    },
    ignoreReasonFor: (abs) =>
      ignored.some((i) => abs.endsWith(i)) ? path.join(ROOT, ".gitignore") : undefined,
  };
}

function webRoot(overrides: Partial<ExtraRootConfig> = {}): ExtraRootConfig {
  return {
    path: "apps/web",
    kind: "web",
    include: defaultIncludeFor("web"),
    exclude: [],
    ...overrides,
  };
}

suite("extraRootsCollector", () => {
  test("include の既定に一致するファイルだけを集め、ルート相対パスで返す", () => {
    const result = collectExtraRoots(
      ROOT,
      [webRoot()],
      fakeDeps({
        "apps/web": ["src/App.tsx", "src/api.ts", "index.html", "README.md", "src/a.css"],
      }),
    );
    assert.deepStrictEqual(
      result.files.map((f) => f.relativePath),
      ["apps/web/index.html", "apps/web/src/a.css", "apps/web/src/api.ts", "apps/web/src/App.tsx"],
    );
    assert.ok(result.files.every((f) => f.kind === "web" && f.rootPath === "apps/web"));
    assert.ok(result.files.every((f) => path.isAbsolute(f.absolutePath)));
    assert.ok(result.diagnostics.some((d) => d.message.includes("include 対象外 1 件")));
  });

  test("node_modules / dist / build / .vite / *.map / .env* は include に関わらず除外(件数のみ診断)", () => {
    const result = collectExtraRoots(
      ROOT,
      [webRoot({ include: ["**/*"] })],
      fakeDeps({
        "apps/web": [
          "src/App.tsx",
          "node_modules/react/index.js",
          "dist/assets/index.js",
          "build/x.js",
          ".vite/deps/x.js",
          "src/App.tsx.map",
          ".env",
          ".env.local",
          "src/.env.production",
        ],
      }),
    );
    assert.deepStrictEqual(
      result.files.map((f) => f.relativePath),
      ["apps/web/src/App.tsx"],
    );
    assert.strictEqual(result.skipped.length, 0);
    assert.ok(result.diagnostics.some((d) => d.message.includes("既定の除外 8 件")));
  });

  test("exclude・バイナリ・.gitignore は理由付きで skipped に載る", () => {
    const result = collectExtraRoots(
      ROOT,
      [webRoot({ include: ["**/*"], exclude: ["src/generated/**"] })],
      fakeDeps(
        {
          "apps/web": ["src/App.tsx", "src/generated/contract.ts", "public/logo.png", "src/local.ts"],
        },
        ["local.ts"],
      ),
    );
    assert.deepStrictEqual(
      result.files.map((f) => f.relativePath),
      ["apps/web/src/App.tsx"],
    );
    assert.deepStrictEqual(
      result.skipped.map((s) => [s.relativePath, s.reason.split("(")[0]]),
      [
        ["apps/web/src/generated/contract.ts", "extraRoots の exclude に一致"],
        ["apps/web/public/logo.png", "バイナリ拡張子"],
        ["apps/web/src/local.ts", ".gitignore により除外"],
      ],
    );
  });

  test("走査できないディレクトリは警告してスキップ(他のルートは続行)", () => {
    const result = collectExtraRoots(
      ROOT,
      [webRoot({ path: "missing" }), webRoot({ path: "contract", kind: "contract", include: ["**/*.ts"] })],
      fakeDeps({ contract: ["contract.ts"] }),
    );
    assert.deepStrictEqual(
      result.files.map((f) => f.relativePath),
      ["contract/contract.ts"],
    );
    assert.ok(
      result.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("missing"),
      ),
    );
  });
});
