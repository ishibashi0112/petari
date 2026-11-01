/**
 * 自動テストの有無の判定(テスト戦略メモ §7-1、手順文 v6)。
 *
 * 手順文の「自動テスト」の節({{TEST_SECTIONS}})は、プロジェクトに自動テストが
 * あるときだけ入れる。旧 WinForms のみのプロジェクト(テストなし)では手順文が
 * v5 と同一になるよう、判定は次の 2 つだけで行い、推測はしない。
 *
 *   (a) 出力する <file> のルート相対パスに、`e2e/` で始まる / `/e2e/` を含む /
 *       末尾が `.spec.ts` `.spec.tsx` `.test.ts` `.test.tsx` のものがある
 *   (b) slnmix.config.json の extraRoots に kind: "test" がある
 *
 * 純粋関数(ファイルシステムに触れない)。cli.ts が buildRepomixOutput の結果と
 * 設定を渡し、結果を手順文の描画と標準エラーの要約行に使う。
 */

export interface AutoTestDetection {
  /** 自動テストがあるとみなすか */
  present: boolean;
  /** パック内で一致したパス(出力順。表示は先頭 1 件 + 件数) */
  matchedPaths: string[];
  /** extraRoots に kind: "test" があるか */
  testRoot: boolean;
}

const TEST_FILE_SUFFIXES = [".spec.ts", ".spec.tsx", ".test.ts", ".test.tsx"] as const;

/**
 * 1 パスが自動テストのファイルか。区切りは `\` も `/` に揃え、大文字小文字は
 * 区別しない(Windows のファイルシステムに合わせる)。
 */
export function isAutoTestPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.startsWith("e2e/") || normalized.includes("/e2e/")) {
    return true;
  }
  return TEST_FILE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * @param filePaths 出力する <file> のパス(path 属性と同じ)
 * @param extraRoots slnmix.config.json の extraRoots(kind だけ見る)
 */
export function detectAutoTests(
  filePaths: readonly string[],
  extraRoots: readonly { kind: string }[],
): AutoTestDetection {
  const matchedPaths = filePaths.filter(isAutoTestPath);
  const testRoot = extraRoots.some((root) => root.kind === "test");
  return { present: matchedPaths.length > 0 || testRoot, matchedPaths, testRoot };
}

/** CLI の 1 行表示用: 「あり(理由)」または「なし」 */
export function describeAutoTests(detection: AutoTestDetection): string {
  if (!detection.present) {
    return "なし";
  }
  const reasons: string[] = [];
  if (detection.matchedPaths.length > 0) {
    const first = detection.matchedPaths[0]!;
    const rest = detection.matchedPaths.length - 1;
    reasons.push(
      `パック内に ${first}${rest > 0 ? ` ほか ${rest} 件` : ""}`,
    );
  }
  if (detection.testRoot) {
    reasons.push('extraRoots に kind: "test"');
  }
  return `あり(${reasons.join(" / ")})`;
}
