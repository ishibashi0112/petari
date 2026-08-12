import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sjisEncode } from "../src/core/sjis.ts";
import { sha256 } from "../src/infra/files.ts";
import { startDiffServer, type DiffServerOptions, type EditEntry } from "../src/infra/diff-server.ts";

const sjis = (s: string): Uint8Array => {
  const r = sjisEncode(s);
  if (r.unencodable.length > 0) throw new Error(`test fixture unencodable: ${r.unencodable}`);
  return r.bytes;
};
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};
const CRLF = Uint8Array.of(0x0d, 0x0a);

interface Ctx {
  root: string;
  filePath: string;
  originalBytes: Uint8Array;
  url: string;
  origin: string;
  port: number;
  token: string;
  handle: Awaited<ReturnType<typeof startDiffServer>>;
}

/** SJIS + CRLF の 2 行ファイルとスナップショットを持つプロジェクトでサーバーを起動する */
async function setup(over?: Partial<DiffServerOptions>, extraEntries?: EditEntry[]): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "petari-dsrv-"));
  const filePath = join(root, "a.txt");
  const originalBytes = cat(sjis("一行目"), CRLF, sjis("二行目"), CRLF);
  writeFileSync(filePath, originalBytes);
  const snapDir = mkdtempSync(join(tmpdir(), "petari-dsrv-snap-"));
  const snapshotPath = join(snapDir, "a.txt");
  writeFileSync(snapshotPath, cat(sjis("一行目"), CRLF, sjis("旧二行目"), CRLF));
  const entries: EditEntry[] = [
    { path: "a.txt", absPath: filePath, snapshotPath, op: "replace" },
    ...(extraEntries ?? []),
  ];
  const handle = await startDiffServer({
    title: "petari 履歴 TEST",
    entries,
    root,
    leftLabel: "適用前 (before)",
    fallbackEol: "lf",
    ...over,
  });
  const u = new URL(handle.url);
  const token = u.pathname.split("/").filter((s) => s !== "")[0] as string;
  return {
    root,
    filePath,
    originalBytes,
    url: handle.url,
    origin: u.origin,
    port: Number(u.port),
    token,
    handle,
  };
}

const post = (url: string, body: string, headers?: Record<string, string>): Promise<Response> =>
  fetch(url, {
    method: "POST",
    body,
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  });

const saveBody = (base: string, text: string): string =>
  new URLSearchParams({ baseSha256: base, text }).toString();

describe("startDiffServer: 認証・ルーティング (§9)", () => {
  it("トークン不一致は 404 (長さ違いでも throw しない)", async () => {
    const c = await setup();
    try {
      for (const bad of ["0".repeat(32), "abc", "0".repeat(33)]) {
        const res = await fetch(`${c.origin}/${bad}/`);
        expect(res.status).toBe(404);
      }
    } finally {
      c.handle.close();
    }
  });

  it("Host ヘッダ偽装は 400 (DNS rebinding 対策)", async () => {
    const c = await setup();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: c.port,
            path: `/${c.token}/`,
            method: "GET",
            headers: { host: "evil.example:80" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(400);
    } finally {
      c.handle.close();
    }
  });

  it("一覧ページはファイルを列挙し、全応答にセキュリティヘッダが付く", async () => {
    const c = await setup();
    try {
      const res = await fetch(c.url);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("a.txt");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("no-store");
      // 404 にも同じヘッダが付く
      const nf = await fetch(`${c.url}zzz`);
      expect(nf.status).toBe(404);
      expect(nf.headers.get("content-security-policy")).toContain("default-src 'none'");
    } finally {
      c.handle.close();
    }
  });

  it("末尾スラッシュなしのトークン URL は 308 で寄せる", async () => {
    const c = await setup();
    try {
      const res = await fetch(`${c.origin}/${c.token}`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`/${c.token}/`);
    } finally {
      c.handle.close();
    }
  });

  it("編集ページは現在の内容と baseSha256 を含み、nonce CSP が付く", async () => {
    const c = await setup();
    try {
      const res = await fetch(`${c.url}f/0`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("一行目");
      expect(html).toContain(sha256(c.originalBytes));
      // スナップショット全文は埋め込み JSON で monaco に渡される
      expect(html).toContain("旧二行目");
      // エディタページのみ 'self' + nonce の script-src (一覧は JS 不可の基本 CSP)
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self' 'nonce-");
      const index = await fetch(c.url);
      expect(index.headers.get("content-security-policy")).not.toContain("script-src");
    } finally {
      c.handle.close();
    }
  });

  it("不正なインデックスは 404 (範囲外・非整数・先頭ゼロ)", async () => {
    const c = await setup();
    try {
      for (const bad of ["f/1", "f/x", "f/00", "f/-1", "f/0/extra"]) {
        const res = await fetch(`${c.url}${bad}`);
        expect(res.status).toBe(404);
      }
    } finally {
      c.handle.close();
    }
  });
});

describe("startDiffServer: 保存 (§8, §9)", () => {
  it("保存成功でディスクのバイト列が §8 保全どおりになる", async () => {
    const c = await setup();
    try {
      const res = await post(
        `${c.url}f/0`,
        saveBody(sha256(c.originalBytes), "一行目\r\n書換え\r\n"),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/${c.token}/f/0?saved=1`);
      const after = new Uint8Array(readFileSync(c.filePath));
      expect(after).toEqual(cat(sjis("一行目"), CRLF, sjis("書換え"), CRLF));
      // saved=1 でバナーが出る
      const page = await fetch(`${c.origin}${res.headers.get("location")}`);
      expect(await page.text()).toContain("保存しました");
    } finally {
      c.handle.close();
    }
  });

  it("baseSha256 不一致は 409 でファイルに触らない", async () => {
    const c = await setup();
    try {
      const res = await post(`${c.url}f/0`, saveBody("0".repeat(64), "x\r\n"));
      expect(res.status).toBe(409);
      expect(new Uint8Array(readFileSync(c.filePath))).toEqual(c.originalBytes);
    } finally {
      c.handle.close();
    }
  });

  it("baseSha256 の形式不正は 400", async () => {
    const c = await setup();
    try {
      const res = await post(`${c.url}f/0`, saveBody("not-a-sha", "x\r\n"));
      expect(res.status).toBe(400);
    } finally {
      c.handle.close();
    }
  });

  it("Content-Type が urlencoded 以外は 415", async () => {
    const c = await setup();
    try {
      const res = await post(`${c.url}f/0`, "{}", { "content-type": "application/json" });
      expect(res.status).toBe(415);
    } finally {
      c.handle.close();
    }
  });

  it("Origin が自分以外は 403", async () => {
    const c = await setup();
    try {
      const res = await post(`${c.url}f/0`, saveBody("0".repeat(64), "x"), {
        origin: "http://evil.example",
      });
      expect(res.status).toBe(403);
      expect(new Uint8Array(readFileSync(c.filePath))).toEqual(c.originalBytes);
    } finally {
      c.handle.close();
    }
  });

  it("ボディ上限超過は 413", async () => {
    const c = await setup();
    try {
      let status: number | null = null;
      try {
        const res = await post(`${c.url}f/0`, `text=${"a".repeat(17 * 1024 * 1024)}`);
        status = res.status;
      } catch {
        // サーバーが途中で接続を切った場合は fetch が失敗する (どちらも上限が効いた証拠)
      }
      if (status !== null) expect(status).toBe(413);
      expect(new Uint8Array(readFileSync(c.filePath))).toEqual(c.originalBytes);
    } finally {
      c.handle.close();
    }
  });

  it("対象が symlink にすり替えられていたら保存を拒否する", async () => {
    const c = await setup();
    const outside = join(mkdtempSync(join(tmpdir(), "petari-dsrv-out-")), "victim.txt");
    writeFileSync(outside, "untouched");
    try {
      const base = sha256(c.originalBytes);
      unlinkSync(c.filePath);
      symlinkSync(outside, c.filePath);
      const res = await post(`${c.url}f/0`, saveBody(base, "pwned\r\n"));
      expect(res.status).toBe(403);
      expect(readFileSync(outside, "utf8")).toBe("untouched");
    } finally {
      c.handle.close();
    }
  });

  it("Shift_JIS に変換できない文字はバナー付き再表示でファイルに触らない", async () => {
    const c = await setup();
    try {
      const res = await post(
        `${c.url}f/0`,
        saveBody(sha256(c.originalBytes), "一行目\r\n€\r\n"),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("変換できない文字");
      // ユーザーの入力は textarea に保持される
      expect(html).toContain("€");
      expect(new Uint8Array(readFileSync(c.filePath))).toEqual(c.originalBytes);
    } finally {
      c.handle.close();
    }
  });

  it("ajax=1 の保存は JSON で応答し、新しい baseSha256 を返す", async () => {
    const c = await setup();
    try {
      const res = await post(
        `${c.url}f/0`,
        `${saveBody(sha256(c.originalBytes), "一行目\n書換え\n")}&ajax=1`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const json = (await res.json()) as { ok: boolean; baseSha256: string };
      expect(json.ok).toBe(true);
      const after = new Uint8Array(readFileSync(c.filePath));
      expect(after).toEqual(cat(sjis("一行目"), CRLF, sjis("書換え"), CRLF));
      expect(json.baseSha256).toBe(sha256(after));
    } finally {
      c.handle.close();
    }
  });

  it("ajax=1 の競合は 409 JSON でファイルに触らない", async () => {
    const c = await setup();
    try {
      const res = await post(`${c.url}f/0`, `${saveBody("0".repeat(64), "x\n")}&ajax=1`);
      expect(res.status).toBe(409);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain("外部で変更");
      expect(new Uint8Array(readFileSync(c.filePath))).toEqual(c.originalBytes);
    } finally {
      c.handle.close();
    }
  });

  it("ajax=1 の変換不能文字は 422 JSON でファイルに触らない", async () => {
    const c = await setup();
    try {
      const res = await post(
        `${c.url}f/0`,
        `${saveBody(sha256(c.originalBytes), "一行目\n€\n")}&ajax=1`,
      );
      expect(res.status).toBe(422);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain("変換できない文字");
      expect(new Uint8Array(readFileSync(c.filePath))).toEqual(c.originalBytes);
    } finally {
      c.handle.close();
    }
  });

  it("delete エントリは一覧に注記が出て保存できない", async () => {
    const root = mkdtempSync(join(tmpdir(), "petari-dsrv-del-"));
    mkdirSync(join(root, "sub"), { recursive: true });
    const c = await setup(undefined, [
      { path: "gone.txt", absPath: join(root, "gone.txt"), snapshotPath: null, op: "delete" },
    ]);
    try {
      const index = await (await fetch(c.url)).text();
      expect(index).toContain("delete のため現在のファイルはありません");
      const res = await post(`${c.url}f/1`, saveBody("0".repeat(64), "x"));
      expect(res.status).toBe(403);
    } finally {
      c.handle.close();
    }
  });
});

describe("startDiffServer: 同梱 monaco 資産の配信 (§9)", () => {
  const vendored = existsSync(
    join(process.cwd(), "vendor", "monaco", "vs", "loader.js"),
  );

  it.runIf(vendored)("許可リストにある資産だけを配信する", async () => {
    const c = await setup();
    try {
      const ok = await fetch(`${c.url}vs/loader.js`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("text/javascript");
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      // 列挙済みリストへの完全一致のみ。".." は URL 正規化後もリスト外 → 404
      // (vendor 外への到達は Set の構造上あり得ない)
      for (const bad of ["vs/nope.js", "vs/../package.json"]) {
        const res = await fetch(`${c.url}${bad}`);
        expect(res.status).toBe(404);
      }
    } finally {
      c.handle.close();
    }
  });

  it.runIf(vendored)("資産配信もトークン必須 (トークンなしは 404)", async () => {
    const c = await setup();
    try {
      const res = await fetch(`${c.origin}/vs/loader.js`);
      expect(res.status).toBe(404);
    } finally {
      c.handle.close();
    }
  });
});

describe("startDiffServer: ライフサイクル (§4.3)", () => {
  it("quit で closed が解決し、以後は接続できない", async () => {
    const c = await setup();
    const res = await post(`${c.url}quit`, "");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("終了しました");
    expect(await c.handle.closed).toBe("quit");
    await expect(fetch(c.url)).rejects.toThrow();
  });

  it("無操作タイムアウトで idle として終了する", async () => {
    const c = await setup({ idleTimeoutMs: 100 });
    expect(await c.handle.closed).toBe("idle");
  });
});
