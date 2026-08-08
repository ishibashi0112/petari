/**
 * エンコーディングと改行の保全 (§8 — 最重要要件)。
 *
 * 方針: ファイルを「行単位のドキュメント」として扱い、各行の元バイト列 (raw) と
 * 実際の改行コードを保持する。書き込み時、変更していない行は raw をそのまま出力する。
 * これにより Shift_JIS の重複マッピング (NEC/IBM 拡張等) があっても、
 * 触っていない行のバイト列は原理的に変わらない。再エンコードは変更行のみ。
 */
import { sjisEncode } from "./sjis.ts";

export type FileEncoding = "utf8" | "shift_jis";
export type Eol = "lf" | "crlf";

export class EncodingError extends Error {}

export interface DocLine {
  /** デコード済みテキスト (改行なし) */
  text: string;
  /** 元ファイルのバイト列 (改行なし)。新規・置換行は null → 書き込み時に再エンコード */
  raw: Uint8Array | null;
  /** この行の実際の改行。null = 新規行 or 最終行 (改行なし) */
  eol: Eol | null;
}

export interface FileDocument {
  encoding: FileEncoding;
  hasBom: boolean;
  /** 支配的な改行コード (新規挿入行に使う)。改行が 1 つもないファイルは null */
  eol: Eol | null;
  trailingNewline: boolean;
  lines: DocLine[];
}

const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const LF = Uint8Array.of(0x0a);
const CRLF = Uint8Array.of(0x0d, 0x0a);

function tryDecode(bytes: Uint8Array, label: "utf-8" | "shift_jis"): boolean {
  try {
    new TextDecoder(label, { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * バイト列からエンコーディング・BOM・改行を検出し、行ドキュメントに分解する (§8)。
 * 判定順: UTF-16 BOM → 非対応エラー / UTF-8 BOM / 厳密 UTF-8 / Shift_JIS / エラー。
 * (対象環境のエンコーディングは UTF-8 / Shift_JIS の 2 択という前提。ASCII のみの
 *  ファイルは UTF-8 と判定されるが、どちらで書いても同一バイトになるため実害はない)
 */
export function decodeFile(bytes: Uint8Array): FileDocument {
  if (bytes.length >= 2) {
    const [b0, b1] = [bytes[0], bytes[1]];
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) {
      throw new EncodingError(
        "UTF-16 のファイルは対象外です (UTF-8 か Shift_JIS に変換してから使用してください)",
      );
    }
  }

  let hasBom = false;
  let body = bytes;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    hasBom = true;
    body = bytes.subarray(3);
  }

  let encoding: FileEncoding;
  if (hasBom || tryDecode(body, "utf-8")) {
    if (hasBom && !tryDecode(body, "utf-8")) {
      throw new EncodingError("UTF-8 BOM 付きですが本文が UTF-8 として不正です");
    }
    encoding = "utf8";
  } else if (tryDecode(body, "shift_jis")) {
    encoding = "shift_jis";
  } else {
    throw new EncodingError("エンコーディングを判定できません (UTF-8 でも Shift_JIS でもありません)");
  }

  // 行分割はバイトレベルで行う。UTF-8 の継続バイトも Shift_JIS の 2 バイト目
  // (0x40-0xFC) も 0x0A/0x0D と衝突しないため安全。
  const decoder = new TextDecoder(encoding === "utf8" ? "utf-8" : "shift_jis", { fatal: true });
  const lines: DocLine[] = [];
  let lineStart = 0;
  let crlfCount = 0;
  let lfCount = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0x0a) {
      const isCrlf = i > lineStart && body[i - 1] === 0x0d;
      const raw = body.subarray(lineStart, isCrlf ? i - 1 : i);
      lines.push({ text: decoder.decode(raw), raw, eol: isCrlf ? "crlf" : "lf" });
      if (isCrlf) crlfCount++;
      else lfCount++;
      lineStart = i + 1;
    }
  }
  let trailingNewline = lines.length > 0;
  if (lineStart < body.length) {
    const raw = body.subarray(lineStart);
    lines.push({ text: decoder.decode(raw), raw, eol: null });
    trailingNewline = false;
  }

  const eol: Eol | null =
    crlfCount === 0 && lfCount === 0 ? null : crlfCount >= lfCount ? "crlf" : "lf";
  return { encoding, hasBom, eol, trailingNewline, lines };
}

function encodeText(text: string, encoding: FileEncoding): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(text);
  const { bytes, unencodable } = sjisEncode(text);
  if (unencodable.length > 0) {
    throw new EncodingError(
      `Shift_JIS に変換できない文字が含まれています: ${unencodable.join(" ")}`,
    );
  }
  return bytes;
}

/**
 * 行ドキュメントをバイト列に書き戻す。raw を持つ行はバイト列をそのまま出力し、
 * raw のない行 (新規・置換) のみエンコードする。
 * fallbackEol は改行を 1 つも持たないファイルに行を追加した場合にのみ使われる。
 */
export function encodeDocument(doc: FileDocument, fallbackEol: Eol = "lf"): Uint8Array {
  const chunks: Uint8Array[] = [];
  if (doc.hasBom) chunks.push(BOM);
  const defaultEol = doc.eol ?? fallbackEol;
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i] as DocLine;
    chunks.push(line.raw ?? encodeText(line.text, doc.encoding));
    const isLast = i === doc.lines.length - 1;
    if (!isLast || doc.trailingNewline) {
      chunks.push((line.eol ?? defaultEol) === "crlf" ? CRLF : LF);
    }
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 新規ファイル (create) 用のドキュメントを作る。既定は UTF-8 / LF / 末尾改行あり (§8) */
export function makeDocument(
  textLines: string[],
  opts: { encoding: FileEncoding; bom?: boolean; eol: Eol; trailingNewline?: boolean },
): FileDocument {
  return {
    encoding: opts.encoding,
    hasBom: opts.bom ?? false,
    eol: opts.eol,
    trailingNewline: opts.trailingNewline ?? textLines.length > 0,
    lines: textLines.map((text) => ({ text, raw: null, eol: null })),
  };
}

/** テキストが対象エンコーディングで表現できない文字を返す (適用前検証・§8) */
export function findUnencodable(text: string, encoding: FileEncoding): string[] {
  if (encoding === "utf8") return [];
  return sjisEncode(text).unencodable;
}
