import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import { secretSchema } from "@/api/lib/secret-brands";

const KSEF_LOGIN_PURPOSE = "ksef_login" as const;

const storedKsefLoginSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("token"), token: secretSchema }),
  v.strictObject({
    kind: v.literal("certificate"),
    certificate: v.string(),
    privateKey: secretSchema,
  }),
]);
const envelopeSchema = v.strictObject({
  purpose: v.literal(KSEF_LOGIN_PURPOSE),
  login: storedKsefLoginSchema,
});

export type StoredKsefLogin = v.InferOutput<typeof storedKsefLoginSchema>;
export class KsefLoginCryptoError extends TaggedError("KsefLoginCryptoError")<{
  reason: "invalid_json" | "invalid_envelope";
  message: string;
}> {}

export const encryptKsefLogin = async (
  organizationId: SafeId<"organization">,
  login: StoredKsefLogin,
) =>
  await encryptContent(
    organizationId,
    JSON.stringify({ purpose: KSEF_LOGIN_PURPOSE, login }),
  );

export const decryptKsefLogin = async ({
  organizationId,
  ciphertext,
  iv,
}: {
  organizationId: SafeId<"organization">;
  ciphertext: Buffer;
  iv: Buffer;
}): Promise<Result<StoredKsefLogin, KsefLoginCryptoError>> => {
  const clear = await decryptContent(organizationId, ciphertext, iv);
  const json = Result.try({
    try: (): unknown => JSON.parse(clear),
    catch: () =>
      new KsefLoginCryptoError({
        reason: "invalid_json",
        message: "Stored KSeF login is not valid JSON",
      }),
  });
  if (json.isErr()) {
    return json;
  }
  const parsed = v.safeParse(envelopeSchema, json.value);
  return parsed.success
    ? Result.ok(parsed.output.login)
    : Result.err(
        new KsefLoginCryptoError({
          reason: "invalid_envelope",
          message: "Stored KSeF login envelope is invalid",
        }),
      );
};
