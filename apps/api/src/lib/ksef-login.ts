import { Result } from "better-result";
import { X509Certificate } from "node:crypto";
import * as v from "valibot";

import {
  type Authenticator,
  createKsefCertificateAuthenticator,
  createKsefTokenAuthenticator,
  type KsefEnvironment,
  type KsefTransport,
} from "@stll/invoicing/ksef";

import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptOrganizationSecret } from "@/api/lib/content-encryption";

export const KSEF_LOGIN_PURPOSE = "ksef_login";
export const KSEF_ENVIRONMENTS = ["test", "demo", "production"] as const;

export type StoredKsefLogin =
  | { kind: "token"; token: string }
  | { kind: "certificate"; certificate: string; privateKey: string };
const storedLoginSchema = v.variant("kind", [
  v.object({ kind: v.literal("token"), token: v.string() }),
  v.object({
    kind: v.literal("certificate"),
    certificate: v.string(),
    privateKey: v.string(),
  }),
]);

export const importKsefSigningKey = async (
  encoded: string,
): Promise<Result<CryptoKey, string>> => {
  const bytes = Buffer.from(encoded, "base64");
  for (const algorithm of [
    { name: "ECDSA", namedCurve: "P-256" },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  ] as const) {
    const imported = await Result.tryPromise({
      try: async () =>
        await crypto.subtle.importKey("pkcs8", bytes, algorithm, false, [
          "sign",
        ]),
      catch: () => undefined,
    });
    if (imported.isOk()) {
      return Result.ok(imported.value);
    }
  }
  return Result.err(
    "The KSeF private key must be PKCS#8 DER for ECDSA P-256 or RSA SHA-256 (at least 2048 bits).",
  );
};

export const certificateMetadata = (encoded: string, now = new Date()) => {
  const parsed = Result.try({
    try: () => new X509Certificate(Buffer.from(encoded, "base64")),
    catch: () =>
      "The KSeF certificate must be a valid DER certificate encoded as base64.",
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const validFrom = new Date(parsed.value.validFrom);
  const validTo = new Date(parsed.value.validTo);
  if (validTo <= now) {
    return Result.err(
      "The KSeF certificate has expired; upload a current certificate.",
    );
  }
  if (validFrom > now) {
    return Result.err("The KSeF certificate is not valid yet.");
  }
  return Result.ok({ subject: parsed.value.subject, validFrom, validTo });
};

export const authenticatorFromLogin = async ({
  login,
  target,
  nip,
  transport,
}: {
  login: StoredKsefLogin;
  target: KsefEnvironment;
  nip: string;
  transport: KsefTransport;
}): Promise<Result<Authenticator, string>> => {
  if (login.kind === "token") {
    return Result.ok(
      createKsefTokenAuthenticator({
        environment: target,
        transport,
        nip,
        ksefToken: login.token,
      }),
    );
  }
  const privateKey = await importKsefSigningKey(login.privateKey);
  return privateKey.map((key) =>
    createKsefCertificateAuthenticator({
      environment: target,
      transport,
      nip,
      certificate: Buffer.from(login.certificate, "base64"),
      privateKey: key,
    }),
  );
};

/** The sole production read path that decrypts a stored KSeF login. */
export const ksefAuthenticatorFor = async (
  organizationId: SafeId<"organization">,
  transport: KsefTransport,
): Promise<
  Result<{ authenticator: Authenticator; target: KsefEnvironment }, string>
> => {
  const row = await rootDb.query.organizationSettings.findFirst({
    where: { organizationId: { eq: organizationId } },
    columns: {
      ksefLoginEncrypted: true,
      ksefLoginIv: true,
      ksefLoginTarget: true,
      ksefLoginNip: true,
    },
  });
  if (
    !row?.ksefLoginEncrypted ||
    !row.ksefLoginIv ||
    !row.ksefLoginTarget ||
    !row.ksefLoginNip
  ) {
    return Result.err("No KSeF login is configured for this organization.");
  }
  const clear = await decryptOrganizationSecret(
    organizationId,
    KSEF_LOGIN_PURPOSE,
    row.ksefLoginEncrypted,
    row.ksefLoginIv,
  );
  const login = v.parse(storedLoginSchema, JSON.parse(clear));
  const authenticator = await authenticatorFromLogin({
    login,
    target: row.ksefLoginTarget,
    nip: row.ksefLoginNip,
    transport,
  });
  return authenticator.map((value) => ({
    authenticator: value,
    target: row.ksefLoginTarget,
  }));
};
