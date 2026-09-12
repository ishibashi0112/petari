/**
 * 新規ファイル (create) のエンコーディング・BOM・改行の推定 (設計書 §11.2 P1-b)。
 *
 * 背景: 既定の UTF-8 / LF / BOM なしで日本語コメントを含む .vb を作ると、vbc / VS は
 * システムコードページ (CP932) とみなして化ける。Shift_JIS / CRLF の既存ファイルとも混在する。
 * そこで `newFile.encoding: "auto"` のとき、作成先ディレクトリ (なければ上位) の既存テキスト
 * ファイルの多数決で決める。純粋関数のみ (手本の収集は infra 側)。
 */
import type { NewFileConfig } from "./applier.ts";
import type { Eol, FileEncoding } from "./encoding.ts";

/** 手本 1 ファイルの形式 (infra が decodeFile して集める) */
export interface StyleSample {
  encoding: FileEncoding;
  bom: boolean;
  /** 改行を 1 つも持たないファイルは null (多数決に参加しない) */
  eol: Eol | null;
}

/** 1 ディレクトリ分の手本。sameExt が空でなければそれを優先し、なければ others を使う */
export interface StyleSampleGroup {
  /** 表示用のディレクトリ (ルート相対。ルート直下は "." ) */
  dir: string;
  sameExt: StyleSample[];
  others: StyleSample[];
}

/** config の newFile 設定 (auto を含む)。明示された項目は推定より優先する */
export interface NewFileSetting {
  encoding: FileEncoding | "auto";
  bom?: boolean;
  eol?: Eol;
}

export interface ResolvedNewFile {
  config: NewFileConfig;
  /** 採用根拠 (レポート 1 行分)。auto 以外は null */
  basis: string | null;
}

function majority<T extends string | boolean>(values: T[], tieBreak: T): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = -1;
  for (const [v, n] of counts) {
    if (n > bestCount || (n === bestCount && v === tieBreak)) {
      best = v;
      bestCount = n;
    }
  }
  return best ?? tieBreak;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** auto 以外: 従来どおり明示値 (eol 既定 lf / bom 既定なし) */
export function fixedNewFile(setting: NewFileSetting): NewFileConfig {
  const encoding: FileEncoding = setting.encoding === "auto" ? "utf8" : setting.encoding;
  return { encoding, bom: setting.bom ?? false, eol: setting.eol ?? "lf" };
}

function describe(c: NewFileConfig): string {
  return `${c.encoding}${c.encoding === "utf8" ? (c.bom === true ? " (BOM あり)" : " (BOM なし)") : ""} / ${c.eol}`;
}

/**
 * 作成先に近いディレクトリから順に手本を探し、最初に見つかったディレクトリの多数決で決める。
 * 手本がなければ拡張子別の既定 (.vb → utf8 + BOM + crlf、それ以外 → utf8 / BOM なし / lf)。
 * .vb で utf8 かつ BOM なしになった場合は BOM を付ける (BOM なし UTF-8 の日本語は vbc で化ける。
 * ASCII のみの Shift_JIS ファイルが UTF-8 判定される既知の限界への対処でもある)。
 */
export function resolveNewFileStyle(
  path: string,
  setting: NewFileSetting,
  groups: readonly StyleSampleGroup[],
): ResolvedNewFile {
  if (setting.encoding !== "auto") return { config: fixedNewFile(setting), basis: null };

  const ext = extensionOf(path);
  const isVb = ext === ".vb";
  let config: NewFileConfig;
  let basis: string;

  const found = groups
    .map((g) => ({ g, samples: g.sameExt.length > 0 ? g.sameExt : g.others, same: g.sameExt.length > 0 }))
    .find((x) => x.samples.length > 0);
  if (found === undefined) {
    config = isVb
      ? { encoding: "utf8", bom: true, eol: "crlf" }
      : { encoding: "utf8", bom: false, eol: "lf" };
    basis = `手本となる既存ファイルなし → ${isVb ? ".vb" : "拡張子"} の既定`;
  } else {
    const { g, samples, same } = found;
    const encoding = majority(
      samples.map((s) => s.encoding),
      "utf8",
    );
    const utf8Samples = samples.filter((s) => s.encoding === "utf8");
    const bom =
      encoding === "utf8" ? majority(utf8Samples.map((s) => s.bom), true) : false;
    const eols = samples.map((s) => s.eol).filter((e): e is Eol => e !== null);
    const eol = eols.length > 0 ? majority(eols, "crlf") : isVb ? "crlf" : "lf";
    config = { encoding, bom, eol };
    const what = same
      ? `${ext === "" ? "拡張子なし" : ext} ${samples.length} ファイル`
      : `テキスト ${samples.length} ファイル (同じ拡張子の手本なし)`;
    basis = `${g.dir === "." ? "プロジェクト直下" : g.dir} の ${what}の多数決`;
  }

  // 明示指定があれば推定より優先する
  if (setting.bom !== undefined) config.bom = setting.bom;
  if (setting.eol !== undefined) config.eol = setting.eol;

  if (isVb && config.encoding === "utf8" && config.bom !== true && setting.bom === undefined) {
    config.bom = true;
    basis += " → .vb のため BOM を付与 (BOM なし UTF-8 は vbc で日本語が化ける)";
  }
  return { config, basis: `${describe(config)} (${basis})` };
}
