import { randomBytes } from "node:crypto";

const SHARE_INVITATION_SECRET_BYTES = 32;

/** Generate a 256-bit URL-safe invitation secret. The caller returns it once. */
export const createShareInvitationSecret = (): string =>
  randomBytes(SHARE_INVITATION_SECRET_BYTES).toString("base64url");

/** Persist only this digest; invitation secrets must never enter the database. */
export const hashShareInvitationSecret = (secret: string): string =>
  new Bun.CryptoHasher("sha256").update(secret).digest("hex");
