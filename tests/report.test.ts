import { describe, expect, it } from "vitest";
import { planChangeSet, type FileState, type NewFileConfig } from "../src/core/applier.ts";
import { buildBlankInsensitiveNote, buildFailureReport } from "../src/core/report.ts";
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
  it("照合仕様 (空白・空行・エンコーディング差は吸収済み) を必ず明記する", () => {
    const plan = crossFilePlan();
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("petari の照合仕様");
    expect(report).toContain("空白・空行・インデント・エンコーディングの問題では");
    expect(report).toContain("空行の差は双方から空行を除いた照合で吸収されます");
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

  // 2026-08-30: 空行だけの差は blank-insensitive で自動吸収されるため、このレポートが出るのは
  // 空行以外にも差があるケースのみ。空行が原因と誤読させない文言になっていることを検証する
  it("空行差と内容差が併発したケースでは、空行は原因でないと明記し内容の差へ誘導する", () => {
    const plan = planChangeSet(
      cs({
        op: "replace",
        path: "m.vb",
        line: 1,
        blocks: [
          block(
            // AI が実在しない行 (Log_Result) を混ぜ、かつ空行を落としたケース
            ["        Recalc_CostAmount(io_Dt)", "        Log_Result()", "    End Sub"],
            ["        Recalc_CostAmount(io_Dt)", "    End Sub"],
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
    expect(plan.ok).toBe(false);
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("空行の位置と数");
    expect(report).toContain("失敗の原因は空行ではなく他の行の差にあります");
    expect(report).toContain("SEARCH 2 行目: Log_Result()");
  });

  // 2026-08-25 実運用事例 (空行 1 本の欠落で不一致) の再現形は blank-insensitive で成功するようになった
  it("空行だけの差なら失敗レポートに至らず適用できる (blank-insensitive)", () => {
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
    expect(plan.ok).toBe(true);
    expect(plan.failures).toEqual([]);
    expect(plan.outcomes[0]!.appliedBlocks[0]!.stage).toBe("blank-insensitive");
  });

  it("残り 1 ブロックで全通しになることを検証結果の一覧に構造化して示す", () => {
    const plan = crossFilePlan();
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("失敗は全 2 ブロック中この 1 ブロックだけです");
  });

  it("blank-insensitive で一致したブロックがあれば件数入りの注記を返す (§3.5)", () => {
    const plan = planChangeSet(
      cs({
        op: "replace",
        path: "n.vb",
        line: 1,
        blocks: [block(["Sub A()", "End Sub"], ["Sub A(x As Integer)", "End Sub"])],
      }),
      new Map([["n.vb", state(utf8("Sub A()\n\nEnd Sub\n"))]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(buildBlankInsensitiveNote(plan.outcomes)).toBe(
      "注: 1 件のブロックは空行の差を吸収して適用しました (git diff で空行の並びを確認してください)",
    );
  });

  it("blank-insensitive のブロックが無ければ注記は null", () => {
    const plan = crossFilePlan();
    expect(buildBlankInsensitiveNote(plan.outcomes)).toBeNull();
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
