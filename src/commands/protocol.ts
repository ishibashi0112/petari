/**
 * petari protocol — 規約文を標準出力に出す (§4.5)。
 * slnmix / repomix 連携の single source。
 */
import { PROTOCOL_TEXT } from "../assets/protocol.ts";

export async function protocolCommand(_argv: string[]): Promise<number> {
  process.stdout.write(PROTOCOL_TEXT);
  return 0;
}
