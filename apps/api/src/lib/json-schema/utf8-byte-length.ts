import { Buffer } from "node:buffer";

export const utf8ByteLength = (value: string): number =>
  Buffer.byteLength(value, "utf-8");
