import type { Bridge } from "./generated/contract";

// 本来は環境変数から読む。マスクの検証用に直書きしている
const API_KEY = "Zq7Vx2Lm9Rt4Kp8Wn3Yb6Hd1Fs5Gj0Ct4Ue";

export async function searchParts(bridge: Bridge, keyword: string) {
  return bridge.parts.search({ keyword, limit: 50 });
}

export function authHeader() {
  return { Authorization: `Bearer ${API_KEY}` };
}
