/**
 * tazuna protocol — 規約文を標準出力に出す (§4.5)。
 * パック (tazuna pack) は内蔵の規約文を直接使う。repomix など別の道具で使うとき用。
 */
import { PROTOCOL_TEXT } from "../assets/protocol.ts";

export async function protocolCommand(_argv: string[]): Promise<number> {
  process.stdout.write(PROTOCOL_TEXT);
  return 0;
}
