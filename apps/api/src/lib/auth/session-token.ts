import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

export const hashSessionToken = (token: string) => hashSha256Hex(token);
