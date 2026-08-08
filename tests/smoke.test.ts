import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";

describe("cli", () => {
  it("--version が 0 で終了する", async () => {
    expect(await main(["--version"])).toBe(0);
  });

  it("存在しない changes.md パスは 1 で終了する", async () => {
    expect(await main(["/no/such/changes.md"])).toBe(1);
  });
});
