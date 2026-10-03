import { createHash } from "node:crypto";

export const hashSessionToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
