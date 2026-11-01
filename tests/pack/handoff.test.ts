/**
 * planHandoff(Copilot Chat への受け渡し)の単体テスト。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import { planHandoff } from "../../src/pack/handoff.ts";

suite("planHandoff", () => {
  test("パックが上限以内ならパック全体を貼る(添付不要)", () => {
    assert.deepStrictEqual(planHandoff("x".repeat(100), "prompt", 100), {
      kind: "paste-pack",
      text: "x".repeat(100),
    });
  });

  test("パックが上限を超えれば本文用テキストを貼る(パックは添付)", () => {
    assert.deepStrictEqual(planHandoff("x".repeat(101), "prompt", 100), {
      kind: "paste-prompt",
      text: "prompt",
    });
  });

  test("パックが大きく本文用テキストも無ければ何も入れない", () => {
    assert.deepStrictEqual(planHandoff("x".repeat(101), undefined, 100), { kind: "none" });
  });

  test("本文用テキストが無くても小さいパックは貼る", () => {
    assert.deepStrictEqual(planHandoff("pack", undefined, 100), { kind: "paste-pack", text: "pack" });
  });
});
