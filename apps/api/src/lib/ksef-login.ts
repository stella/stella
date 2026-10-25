import { Result, TaggedError } from "better-result";
import { X509Certificate } from "node:crypto";

import {
  type Authenticator,
  createKsefCertificateAuthenticator,
  createKsefTokenAuthenticator,
  type KsefEnvironment,
  type KsefTransport,
} from "@stll/invoicing/ksef";

import type { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import {
  decryptKsefLogin,
  type StoredKsefLogin,
} from "@/api/lib/ksef-login-crypto";

export const KSEF_ENVIRONMENTS = ["test", "demo", "production"] as const;

export class KsefLoginError extends TaggedError("KsefLoginError")<{
  reason:
    | "certificate_expired"
    | "certificate_invalid"
    | "certificate_not_yet_valid"
    | "key_invalid"
    | "login_not_configured"
    | "stored_login_invalid";
  message: string;
  ecFailure?: string;
  rsaFailure?: string;
}> {}

export const importKsefSigningKey = async (
  encoded: string,
): Promise<Result<CryptoKey, KsefLoginError>> => {
  const bytes = Buffer.from(encoded, "base64");
  const ec = await Result.tryPromise({
    try: async () =>
      await crypto.subtle.importKey(
        "pkcs8",
        bytes,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
    catch: String,
  });
  if (ec.isOk()) {
    return Result.ok(ec.value);
  }
  const rsa = await Result.tryPromise({
    try: async () =>
      await crypto.subtle.importKey(
        "pkcs8",
        bytes,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    catch: String,
  });
  if (rsa.isOk()) {
    return Result.ok(rsa.value);
  }
  return Result.err(
    new KsefLoginError({
      reason: "key_invalid",
      message:
        "The KSeF private key must be PKCS#8 DER for ECDSA P-256 or RSA SHA-256 (at least 2048 bits).",
      ecFailure: ec.error,
      rsaFailure: rsa.error,
    }),
  );
};

export const certificateMetadata = (encoded: string, now = new Date()) => {
  const parsed = Result.try({
    try: () => new X509Certificate(Buffer.from(encoded, "base64")),
    catch: () =>
      new KsefLoginError({
        reason: "certificate_invalid",
        message:
          "The KSeF certificate must be a valid DER certificate encoded as base64.",
      }),
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const validFrom = new Date(parsed.value.validFrom);
  const validTo = new Date(parsed.value.validTo);
  if (validTo <= now) {
    return Result.err(
      new KsefLoginError({
        reason: "certificate_expired",
        message:
          "The KSeF certificate has expired; upload a current certificate.",
      }),
    );
  }
  if (validFrom > now) {
    return Result.err(
      new KsefLoginError({
        reason: "certificate_not_yet_valid",
        message: "The KSeF certificate is not valid yet.",
      }),
    );
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
}): Promise<Result<Authenticator, KsefLoginError>> => {
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
  database: Pick<typeof rootDb, "query">,
): Promise<
  Result<
    { authenticator: Authenticator; target: KsefEnvironment },
    KsefLoginError
  >
> => {
  const row = await database.query.organizationSettings.findFirst({
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
    return Result.err(
      new KsefLoginError({
        reason: "login_not_configured",
        message: "No KSeF login is configured for this organization.",
      }),
    );
  }
  const decrypted = await decryptKsefLogin({
    organizationId,
    ciphertext: row.ksefLoginEncrypted,
    iv: row.ksefLoginIv,
  });
  if (decrypted.isErr()) {
    return Result.err(
      new KsefLoginError({
        reason: "stored_login_invalid",
        message: decrypted.error.message,
      }),
    );
  }
  const login = decrypted.value;
  const target = row.ksefLoginTarget;
  const authenticator = await authenticatorFromLogin({
    login,
    target,
    nip: row.ksefLoginNip,
    transport,
  });
  return authenticator.map((value) => ({ authenticator: value, target }));
};
