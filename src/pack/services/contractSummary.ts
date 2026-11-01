/**
 * contract.schema.json(webview2-bridge の gen が出す中間表現)から
 * メソッド・イベント・DTO の一覧を生成する(<contract_summary> 用)。
 *
 * 構造は webview2-bridge/packages/gen/src/schema.ts を正とする:
 *   { $schema, contractVersion: 1, $defs: {id: JsonSchema},
 *     methods: {group: {name: {input, output}}}, events: {name: JsonSchema} }
 *
 * zod は入れず JSON をそのまま読む。contractVersion が既知(1)でなければ
 * 要約せず理由を返す(呼び出し側で <skipped_files> に載せ、原文の
 * contract.ts だけを出す)。JSON Schema の解釈は型の見た目を作るのに必要な
 * 範囲だけ(推測で補完せず、分からないものは unknown と書く)。
 */

const DEFS_PREFIX = "#/$defs/";
const SUPPORTED_CONTRACT_VERSION = 1;
/** オブジェクト型を入れ子で展開する深さの上限(これより深いと {...}) */
const MAX_OBJECT_DEPTH = 2;
/** primitive に添える description の最大長 */
const MAX_DESCRIPTION_LENGTH = 40;

export type ContractSummaryResult =
  | { ok: true; lines: string[]; methodCount: number; eventCount: number; typeCount: number }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortDescription(schema: Record<string, unknown>): string {
  const description = schema["description"];
  if (typeof description !== "string") {
    return "";
  }
  const first = description.split(/[。\n(（]/)[0]?.trim() ?? "";
  if (first === "") {
    return "";
  }
  return `(${first.length > MAX_DESCRIPTION_LENGTH ? `${first.slice(0, MAX_DESCRIPTION_LENGTH)}…` : first})`;
}

/** JSON Schema を TypeScript 風の型表記にする */
export function renderType(schema: unknown, depth = 0): string {
  if (!isRecord(schema)) {
    return "unknown";
  }
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    return ref.startsWith(DEFS_PREFIX) ? ref.slice(DEFS_PREFIX.length) : `unknown(${ref})`;
  }
  if (Array.isArray(schema["enum"])) {
    return schema["enum"].map((v) => JSON.stringify(v)).join(" | ");
  }
  if ("const" in schema) {
    return JSON.stringify(schema["const"]);
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    const variants = schema[keyword];
    if (Array.isArray(variants)) {
      return variants.map((v) => renderType(v, depth)).join(" | ");
    }
  }
  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    return allOf.map((v) => renderType(v, depth)).join(" & ");
  }
  const type = schema["type"];
  if (Array.isArray(type)) {
    return type.map((t) => renderType({ ...schema, type: t }, depth)).join(" | ");
  }
  if (type === "array") {
    const items = renderType(schema["items"], depth);
    return /[ |&]/.test(items) ? `(${items})[]` : `${items}[]`;
  }
  if (type === "object" || isRecord(schema["properties"])) {
    const properties = schema["properties"];
    if (isRecord(properties)) {
      if (depth >= MAX_OBJECT_DEPTH) {
        return "{...}";
      }
      const required = new Set(
        Array.isArray(schema["required"])
          ? schema["required"].filter((r): r is string => typeof r === "string")
          : [],
      );
      const fields = Object.entries(properties).map(
        ([name, prop]) =>
          `${name}${required.has(name) ? "" : "?"}: ${renderType(prop, depth + 1)}`,
      );
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
    }
    const additional = schema["additionalProperties"];
    if (isRecord(additional)) {
      return `Record<string, ${renderType(additional, depth + 1)}>`;
    }
    return "object";
  }
  if (typeof type === "string") {
    return `${type}${shortDescription(schema)}`;
  }
  return "unknown";
}

/**
 * contract.schema.json の内容から要約行を生成する。
 * 先頭の説明行は付けない(呼び出し側が契約ファイル・生成ディレクトリを添えて書く)。
 */
export function summarizeContractSchema(jsonText: string): ContractSummaryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.replace(/^﻿/, ""));
  } catch (error) {
    return {
      ok: false,
      reason: `JSON として読めません: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "トップレベルがオブジェクトではありません" };
  }
  const version = parsed["contractVersion"];
  if (version !== SUPPORTED_CONTRACT_VERSION) {
    return {
      ok: false,
      reason: `未知の形式です(contractVersion: ${
        version === undefined ? "なし" : JSON.stringify(version)
      }。対応: ${SUPPORTED_CONTRACT_VERSION})`,
    };
  }
  const methods = parsed["methods"];
  const events = parsed["events"];
  const defs = parsed["$defs"];
  if (
    (methods !== undefined && !isRecord(methods)) ||
    (events !== undefined && !isRecord(events)) ||
    (defs !== undefined && !isRecord(defs))
  ) {
    return { ok: false, reason: "methods / events / $defs の形が想定と異なります" };
  }

  const lines: string[] = [];
  let methodCount = 0;
  let eventCount = 0;
  let typeCount = 0;

  lines.push("methods:");
  if (isRecord(methods)) {
    for (const [group, members] of Object.entries(methods)) {
      if (!isRecord(members)) {
        lines.push(`- ${group}: unknown(想定外の形)`);
        continue;
      }
      for (const [name, method] of Object.entries(members)) {
        const input = isRecord(method) ? renderType(method["input"]) : "unknown";
        const output = isRecord(method) ? renderType(method["output"]) : "unknown";
        lines.push(`- ${group}.${name}(input: ${input}) -> ${output}`);
        methodCount += 1;
      }
    }
  }
  if (methodCount === 0) {
    lines.push("(なし)");
  }

  lines.push("events:");
  if (isRecord(events)) {
    for (const [name, payload] of Object.entries(events)) {
      lines.push(`- ${name}(payload: ${renderType(payload)})`);
      eventCount += 1;
    }
  }
  if (eventCount === 0) {
    lines.push("(なし)");
  }

  lines.push("types:");
  if (isRecord(defs)) {
    for (const [name, def] of Object.entries(defs)) {
      lines.push(`- ${name} ${renderType(def)}`);
      typeCount += 1;
    }
  }
  if (typeCount === 0) {
    lines.push("(なし)");
  }

  return { ok: true, lines, methodCount, eventCount, typeCount };
}
