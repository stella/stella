/**
 * Encrypt/decrypt delegated Microsoft Graph tokens at rest.
 *
 * Reuses the same per-org AES-256-GCM envelope as the MCP connection tokens
 * (`content-encryption.ts`): the ciphertext is bound to the organization via
 * the HKDF-derived key, and the plaintext JSON envelope additionally binds
 * `userId` + `purpose` so a stored access token cannot be replayed as a
 * refresh token or read under a different user. The decrypt boundary is the
 * only place a raw string is minted into a `Secret<...>` brand.
 */

import * as v from "valibot";

import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { Secret, SecretKind } from "@/api/lib/secret-brands";
import { secretSchema } from "@/api/lib/secret-brands";

type SharepointSecretPurpose =
  | "sharepoint_access_token"
  | "sharepoint_refresh_token";

type DecryptedKind<P extends SharepointSecretPurpose> =
  P extends "sharepoint_access_token"
    ? "AccessToken"
    : P extends "sharepoint_refresh_token"
      ? "RefreshToken"
      : never;

type DecryptedFor<P extends SharepointSecretPurpose> = Secret<DecryptedKind<P>>;

const toDecryptedSecret = <K extends SecretKind>(value: string): Secret<K> =>
  v.parse(secretSchema, value);

type SecretEnvelope = {
  purpose: SharepointSecretPurpose;
  secret: string;
  userId: SafeId<"user">;
};

export type EncryptedSecret = {
  ciphertext: Buffer;
  iv: Buffer;
};

export const encryptSharepointSecret = async ({
  organizationId,
  purpose,
  secret,
  userId,
}: {
  organizationId: SafeId<"organization">;
  purpose: SharepointSecretPurpose;
  secret: string;
  userId: SafeId<"user">;
}): Promise<EncryptedSecret> =>
  await encryptContent(
    organizationId,
    JSON.stringify({ purpose, secret, userId } satisfies SecretEnvelope),
  );

export const decryptSharepointSecret = async <
  P extends SharepointSecretPurpose,
>({
  ciphertext,
  iv,
  organizationId,
  purpose,
  userId,
}: {
  ciphertext: Buffer;
  iv: Buffer;
  organizationId: SafeId<"organization">;
  purpose: P;
  userId: SafeId<"user">;
}): Promise<DecryptedFor<P>> => {
  const json = await decryptContent(organizationId, ciphertext, iv);
  const parsed: unknown = JSON.parse(json);

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("purpose" in parsed) ||
    !("secret" in parsed) ||
    !("userId" in parsed) ||
    parsed.purpose !== purpose ||
    parsed.userId !== userId ||
    typeof parsed.secret !== "string"
  ) {
    throw new HandlerError({
      status: 500,
      message: "Stored SharePoint secret envelope is invalid",
    });
  }

  return toDecryptedSecret<DecryptedKind<P>>(parsed.secret);
};
