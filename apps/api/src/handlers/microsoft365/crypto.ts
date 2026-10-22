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

import { Result } from "better-result";
import * as v from "valibot";

import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { Secret, SecretKind } from "@/api/lib/secret-brands";
import { secretSchema } from "@/api/lib/secret-brands";

// Frozen ciphertext context: these persisted purpose values must never change.
export const MICROSOFT365_TOKEN_PURPOSE = {
  access: "sharepoint_access_token",
  refresh: "sharepoint_refresh_token",
} as const;

type Microsoft365SecretPurpose =
  (typeof MICROSOFT365_TOKEN_PURPOSE)[keyof typeof MICROSOFT365_TOKEN_PURPOSE];

type DecryptedKind<P extends Microsoft365SecretPurpose> =
  P extends typeof MICROSOFT365_TOKEN_PURPOSE.access
    ? "AccessToken"
    : P extends typeof MICROSOFT365_TOKEN_PURPOSE.refresh
      ? "RefreshToken"
      : never;

type DecryptedFor<P extends Microsoft365SecretPurpose> = Secret<
  DecryptedKind<P>
>;

const toDecryptedSecret = <K extends SecretKind>(value: string): Secret<K> =>
  v.parse(secretSchema, value);

type SecretEnvelope = {
  purpose: Microsoft365SecretPurpose;
  secret: string;
  userId: SafeId<"user">;
};

export type EncryptedSecret = {
  ciphertext: Buffer;
  iv: Buffer;
};

export const encryptMicrosoft365Secret = async ({
  organizationId,
  purpose,
  secret,
  userId,
}: {
  organizationId: SafeId<"organization">;
  purpose: Microsoft365SecretPurpose;
  secret: string;
  userId: SafeId<"user">;
}): Promise<EncryptedSecret> =>
  await encryptContent(
    organizationId,
    JSON.stringify({
      purpose,
      // oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- envelope passed directly to encryptContent; only ciphertext is stored
      secret,
      userId,
    } satisfies SecretEnvelope),
  );

export const decryptMicrosoft365Secret = async <
  P extends Microsoft365SecretPurpose,
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
}): Promise<Result<DecryptedFor<P>, HandlerError<500>>> =>
  await Result.gen(async function* () {
    const parsed = yield* Result.await(
      Result.tryPromise({
        try: async (): Promise<unknown> =>
          JSON.parse(await decryptContent(organizationId, ciphertext, iv)),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Stored Microsoft 365 secret envelope is invalid",
            cause,
          }),
      }),
    );

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
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Stored Microsoft 365 secret envelope is invalid",
        }),
      );
    }

    return Result.ok(toDecryptedSecret<DecryptedKind<P>>(parsed.secret));
  });
