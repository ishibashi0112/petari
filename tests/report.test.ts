import { describe, expect, it } from "vitest";
import { planChangeSet, type FileState, type NewFileConfig } from "../src/core/applier.ts";
import { buildFailureReport } from "../src/core/report.ts";
import type { ChangeSet, FileChange, ReplaceBlock } from "../src/types.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const NEW_FILE: NewFileConfig = { encoding: "utf8", eol: "lf" };

const block = (search: string[], replace: string[], index = 1): ReplaceBlock => ({
  search,
  replace,
  line: 1,
  index,
});

const cs = (...files: FileChange[]): ChangeSet => ({ header: "概要", files });
const state = (bytes: Uint8Array): FileState => ({ exists: true, symlink: false, bytes });

/** 実運用事例 (2026-08-25) の再現形: 同一 SEARCH が片方のファイルだけ一致しない */
function crossFilePlan() {
  const search = ["Private Sub Init()", "    Dim x As String"];
  return planChangeSet(
    cs(
      {
        op: "replace",
        path: "a.vb",
        line: 1,
        blocks: [block(search, ["Private Sub Init()", "    Dim x As String", "    Cleanup()"])],
      },
      {
        op: "replace",
        path: "b.vb",
        line: 10,
        blocks: [block(search, ["Private Sub Init()", "    Dim x As String", "    Cleanup()"])],
      },
    ),
    new Map([
      ["a.vb", state(utf8("Private Sub Init()\n    Dim x As String\nEnd Sub\n"))],
      ["b.vb", state(utf8("Private Sub Init()\n    Dim x As String = vbNullString\nEnd Sub\n"))],
    ]),
    NEW_FILE,
  );
}

describe("buildFailureReport (§7 拡充)", () => {
  it("照合仕様 (空白・エンコーディング差は吸収済み) を必ず明記する", () => {
    const plan = crossFilePlan();
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("petari の照合仕様");
    expect(report).toContain("空白・インデント・エンコーディングの問題では");
  });

  it("nothingWritten で all-or-nothing の未書き込みをレポート本文に明記する", () => {
    const plan = crossFilePlan();
    const withFlag = buildFailureReport(plan.failures, {
      outcomes: plan.outcomes,
      nothingWritten: true,
    });
    expect(withFlag).toContain("何も書き込んでいません");
    const withoutFlag = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(withoutFlag).not.toContain("何も書き込んでいません");
  });

  it("検証結果の一覧に成功ファイルも載せ、ファイル間の対比を示す", () => {
    const plan = crossFilePlan();
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("検証結果の一覧");
    expect(report).toContain("- a.vb (replace): 1/1 ブロック一致");
    expect(report).toContain("- b.vb (replace): 0/1 ブロック一致");
    expect(report).toContain("OK 一致 (完全一致)");
    expect(report).toContain("NG SEARCH 不一致");
  });

  it("block-not-found には実ファイルの近傍抜粋 (verbatim + 行番号ガター) が付く", () => {
    const plan = crossFilePlan();
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("実ファイルの該当箇所");
    expect(report).toContain("│    Dim x As String = vbNullString");
    expect(report).toContain("凡例");
  });

  it("依頼文は抜粋からのコピーとスナップショット確認を指示する", () => {
    const plan = crossFilePlan();
    const report = buildFailureReport(plan.failures, {});
    expect(report).toContain("「│」より右側を一字一句そのまま");
    expect(report).toContain("最新のファイル内容の共有を依頼");
  });

  it("outcomes 未指定でも従来どおり失敗詳細と依頼を出す", () => {
    const plan = crossFilePlan();
    const report = buildFailureReport(plan.failures);
    expect(report).toContain("適用失敗の詳細");
    expect(report).toContain("<<<<<<< SEARCH");
    expect(report).not.toContain("検証結果の一覧");
  });

  // 2026-08-25 実運用フィードバック: 空行 1 本の欠落を名指しできず誤誘導になった事例への対策
  it("空行欠落ケースでは照合仕様に空行の扱いを明記し、修正のヒントで空行を名指しする", () => {
    const plan = planChangeSet(
      cs({
        op: "replace",
        path: "m.vb",
        line: 1,
        blocks: [
          block(
            ["        Recalc_CostAmount(io_Dt)", "    End Sub"],
            ["        Recalc_CostAmount(io_Dt)", "        Log_Result()", "    End Sub"],
          ),
        ],
      }),
      new Map([
        [
          "m.vb",
          state(utf8("    Sub Update()\n        Recalc_CostAmount(io_Dt)\n\n    End Sub\nEnd Module\n")),
        ],
      ]),
      NEW_FILE,
    );
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("空行は「内容のある 1 行」として数えます");
    expect(report).toContain("修正のヒント");
    expect(report).toContain("空行 1 行");
    expect(report).toContain("+ = 実ファイルにあるが SEARCH にない行");
  });

  it("残り 1 ブロックで全通しになることを検証結果の一覧に構造化して示す", () => {
    const plan = crossFilePlan();
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("失敗は全 2 ブロック中この 1 ブロックだけです");
  });

  it("SEARCH が全滅でも REPLACE 側の内容から近傍領域を推定して示す", () => {
    const plan = planChangeSet(
      cs({
        op: "replace",
        path: "r.vb",
        line: 1,
        blocks: [
          block(
            ["Public Sub Legacy()", "    Call OldImpl()"],
            ["Public Sub Done()", "    Call NewImpl2()"],
          ),
        ],
      }),
      new Map([["r.vb", state(utf8("Public Sub Done()\n    Call NewImpl()\nEnd Sub\n"))]]),
      NEW_FILE,
    );
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("REPLACE 側の内容に近い実ファイル領域");
    expect(report).toContain("│Public Sub Done()");
  });
});
