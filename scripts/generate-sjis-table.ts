/**
 * Shift_JIS (CP932) のエンコード用テーブルを Node 組み込みの TextDecoder から生成する。
 * 外部データを一切取り込まないための仕組み (CLAUDE.md「実行時依存はゼロ」参照)。
 *
 * 実行: pnpm gen:sjis
 * 出力: src/core/sjis-table.ts (コミット対象。手編集禁止)
 *
 * テーブル形式: ポインタ順 (lead 0x81-0x9F, 0xE0-0xFC × trail 0x40-0x7E, 0x80-0xFC) に
 * デコード結果 1 文字を並べた文字列。デコード不能セルは U+FFFD。
 * バイト列はポインタから算術的に復元できるため文字列 1 本で足りる。
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LEADS = 60; // 0x81-0x9F (31) + 0xE0-0xFC (29)
const TRAILS = 188; // 0x40-0x7E (63) + 0x80-0xFC (125)

function pointerToBytes(p: number): [number, number] {
  const li = Math.floor(p / TRAILS);
  const ti = p % TRAILS;
  const lead = li < 0x1f ? 0x81 + li : 0xe0 + (li - 0x1f);
  const trail = ti < 0x3f ? 0x40 + ti : 0x80 + (ti - 0x3f);
  return [lead, trail];
}

const decoder = new TextDecoder("shift_jis", { fatal: true });
let table = "";
let mapped = 0;
for (let p = 0; p < LEADS * TRAILS; p++) {
  const [lead, trail] = pointerToBytes(p);
  let ch = "�";
  try {
    const s = decoder.decode(new Uint8Array([lead, trail]));
    if ([...s].length === 1 && s !== "�") {
      ch = s;
      mapped++;
    }
  } catch {
    // デコード不能セル
  }
  table += ch;
}

const out = `// 自動生成ファイル — 手編集禁止。再生成: pnpm gen:sjis (scripts/generate-sjis-table.ts)
// Node ${process.version} の TextDecoder("shift_jis") から生成 (WHATWG encoding / CP932 互換)。
// ポインタ順の 1 文字テーブル。U+FFFD はデコード不能セル。
export const SJIS_LEADS = ${LEADS};
export const SJIS_TRAILS = ${TRAILS};
export const SJIS_CHARS: string =
  ${JSON.stringify(table)};
`;

const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core", "sjis-table.ts");
writeFileSync(dest, out, "utf8");
console.log(`generated ${dest}: ${mapped} mappings / ${LEADS * TRAILS} cells`);
