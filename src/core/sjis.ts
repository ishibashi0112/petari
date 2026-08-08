/**
 * Shift_JIS (CP932) エンコーダ (§8)。
 * デコードは Node 組み込み TextDecoder("shift_jis") を使い、エンコードは
 * その TextDecoder から生成した逆引きテーブル (sjis-table.ts) で行う。
 * 生成原理上、sjisEncode したバイト列のデコード結果は必ず元の文字列に一致する。
 */
import { SJIS_CHARS, SJIS_TRAILS } from "./sjis-table.ts";

const PLACEHOLDER = "�";

/**
 * WHATWG encoding 仕様でエンコーダから除外されるポインタ範囲 (lead 0xED-0xEF)。
 * NEC 選定 IBM 拡張。同じ文字が IBM 拡張 (lead 0xFA-0xFC) にもあり、
 * Windows のエンコーダは IBM 側を選ぶため、こちらは「他に無い場合のみ」使う。
 */
const NEC_IBM_START = 8272;
const NEC_IBM_END = 8835;

function pointerToBytes(p: number): [number, number] {
  const li = Math.floor(p / SJIS_TRAILS);
  const ti = p % SJIS_TRAILS;
  const lead = li < 0x1f ? 0x81 + li : 0xe0 + (li - 0x1f);
  const trail = ti < 0x3f ? 0x40 + ti : 0x80 + (ti - 0x3f);
  return [lead, trail];
}

let encodeMap: Map<string, number> | null = null;

function getEncodeMap(): Map<string, number> {
  if (encodeMap !== null) return encodeMap;
  const map = new Map<string, number>();
  const record = (p: number): void => {
    const ch = SJIS_CHARS[p] as string;
    if (ch === PLACEHOLDER || map.has(ch)) return;
    const [lead, trail] = pointerToBytes(p);
    map.set(ch, (lead << 8) | trail);
  };
  for (let p = 0; p < SJIS_CHARS.length; p++) {
    if (p < NEC_IBM_START || p > NEC_IBM_END) record(p);
  }
  for (let p = NEC_IBM_START; p <= NEC_IBM_END; p++) record(p);
  encodeMap = map;
  return map;
}

export interface SjisEncodeResult {
  bytes: Uint8Array;
  /** Shift_JIS に変換できなかった文字 (重複除去済み)。空でなければ bytes は不完全 */
  unencodable: string[];
}

export function sjisEncode(text: string): SjisEncodeResult {
  const map = getEncodeMap();
  const out: number[] = [];
  const bad = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      // ASCII。U+005C はバックスラッシュ (SJIS では ¥ 表示) としてそのまま
      out.push(cp);
      continue;
    }
    if (cp === 0xa5) {
      // ¥ → 0x5C (Windows 慣習・WHATWG エンコーダと同じ)
      out.push(0x5c);
      continue;
    }
    if (cp === 0x203e) {
      // ‾ (オーバーライン) → 0x7E
      out.push(0x7e);
      continue;
    }
    if (cp >= 0xff61 && cp <= 0xff9f) {
      // 半角カナ
      out.push(0xa1 + (cp - 0xff61));
      continue;
    }
    const two = map.get(ch);
    if (two === undefined) {
      bad.add(ch);
      continue;
    }
    out.push(two >> 8, two & 0xff);
  }
  return { bytes: Uint8Array.from(out), unencodable: [...bad] };
}

/** text に Shift_JIS へ変換できない文字が含まれるか (検証用・§8) */
export function sjisUnencodable(text: string): string[] {
  return sjisEncode(text).unencodable;
}
