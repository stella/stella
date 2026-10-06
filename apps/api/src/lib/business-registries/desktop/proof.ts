import { defaultKeyHasher } from "@better-auth/api-key";
import { panic, Result } from "better-result";
import { calculateJwkThumbprint, importJWK, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const DESKTOP_PROOF_HEADER = "DPoP";
export const DESKTOP_PROOF_MAX_AGE_SECONDS = 60;
export const DESKTOP_PROOF_FUTURE_SKEW_SECONDS = 5;
const MAX_PROOF_BYTES = 4096;
const publicDeviceKey = v.strictObject({
  kty: v.literal("EC"),
  crv: v.literal("P-256"),
  x: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
  y: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
});
const proofPayload = v.object({
  htm: v.string(),
  htu: v.string(),
  iat: v.pipe(v.number(), v.integer(), v.minValue(0)),
  jti: v.pipe(v.string(), v.uuid()),
  ath: v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u))),
  nonce: v.optional(v.string()),
});

export const deviceProofRefusal = (
  code:
    | "desktop_proof_invalid"
    | "desktop_proof_expired"
    | "desktop_proof_replayed"
    | "desktop_device_mismatch",
) =>
  new HandlerError({
    status: 401,
    code,
    message: "Desktop account proof was refused",
    retryable: false,
  });

type AccountProofBinding = {
  type: "account";
  keyId: string;
  credentialHash: string;
};
type LinkProofBinding = { type: "link"; nonce: string };
type VerifyDeviceProofOptions = {
  request: Request;
  expectedUrl: string;
  expectedThumbprint: string;
  binding:
    | { type: "account"; keyId: string; credential: string }
    | LinkProofBinding;
  now?: Date;
};

type VerifiedProofData = {
  thumbprint: string;
  jti: string;
  expiresAt: Date;
  binding: AccountProofBinding | LinkProofBinding;
  nonce: string | undefined;
};

// Construction requires signature and request binding validation. Handlers
// cannot manufacture an authority by copying client claims into an object.
export class VerifiedDesktopDeviceProof {
  readonly thumbprint: string;
  readonly jti: string;
  readonly expiresAt: Date;
  readonly binding: AccountProofBinding | LinkProofBinding;
  readonly nonce: string | undefined;

  private constructor({
    thumbprint,
    jti,
    expiresAt,
    binding,
    nonce,
  }: VerifiedProofData) {
    this.thumbprint = thumbprint;
    this.jti = jti;
    this.expiresAt = expiresAt;
    this.binding = binding;
    this.nonce = nonce;
  }

  static async verify({
    request,
    expectedUrl,
    expectedThumbprint,
    binding,
    now,
  }: VerifyDeviceProofOptions) {
    const compact = request.headers.get(DESKTOP_PROOF_HEADER);
    if (
      !compact ||
      compact.length > MAX_PROOF_BYTES ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(compact)
    ) {
      return Result.err(deviceProofRefusal("desktop_proof_invalid"));
    }
    const decoded = await Result.tryPromise({
      try: async () => {
        const header: unknown = JSON.parse(
          Buffer.from(compact.split(".").at(0) ?? "", "base64url").toString(
            "utf-8",
          ),
        );
        const parsed = v.safeParse(
          v.strictObject({
            typ: v.literal("dpop+jwt"),
            alg: v.literal("ES256"),
            jwk: publicDeviceKey,
          }),
          header,
        );
        if (!parsed.success) {
          return Result.err(deviceProofRefusal("desktop_proof_invalid"));
        }
        const thumbprint = await calculateJwkThumbprint(
          parsed.output.jwk,
          "sha256",
        );
        if (thumbprint !== expectedThumbprint) {
          return Result.err(deviceProofRefusal("desktop_device_mismatch"));
        }
        const key = await importJWK(parsed.output.jwk, "ES256");
        const verified = await jwtVerify(compact, key, {
          algorithms: ["ES256"],
          typ: "dpop+jwt",
        });
        const payload = v.safeParse(proofPayload, verified.payload);
        if (!payload.success) {
          return Result.err(deviceProofRefusal("desktop_proof_invalid"));
        }
        return Result.ok({ thumbprint, payload: payload.output });
      },
      catch: () => deviceProofRefusal("desktop_proof_invalid"),
    });
    const checked = decoded.andThen((result) => result);
    if (checked.isErr()) {
      return checked;
    }
    const { thumbprint, payload } = checked.value;
    const seconds = Math.floor(
      (now?.getTime() ?? Temporal.Now.instant().epochMilliseconds) / 1000,
    );
    if (
      payload.iat > seconds + DESKTOP_PROOF_FUTURE_SKEW_SECONDS ||
      seconds - payload.iat > DESKTOP_PROOF_MAX_AGE_SECONDS
    ) {
      return Result.err(deviceProofRefusal("desktop_proof_expired"));
    }
    const normalizedUrl = new URL(expectedUrl);
    normalizedUrl.search = "";
    normalizedUrl.hash = "";
    if (
      payload.htm !== request.method ||
      payload.htu !== normalizedUrl.toString()
    ) {
      return Result.err(deviceProofRefusal("desktop_proof_invalid"));
    }
    let verifiedBinding: AccountProofBinding | LinkProofBinding;
    switch (binding.type) {
      case "account": {
        const expected = createHash("sha256")
          .update(binding.credential)
          .digest("base64url");
        if (
          !payload.ath ||
          payload.ath.length !== expected.length ||
          !timingSafeEqual(Buffer.from(payload.ath), Buffer.from(expected))
        ) {
          return Result.err(deviceProofRefusal("desktop_proof_invalid"));
        }
        verifiedBinding = {
          type: "account",
          keyId: binding.keyId,
          credentialHash: await defaultKeyHasher(binding.credential),
        };
        break;
      }
      case "link":
        if (payload.nonce !== binding.nonce || payload.ath !== undefined) {
          return Result.err(deviceProofRefusal("desktop_proof_invalid"));
        }
        verifiedBinding = { type: "link", nonce: binding.nonce };
        break;
      default: {
        binding satisfies never;
        return panic("Unknown desktop proof binding");
      }
    }
    // A proof remains acceptable through the final whole iat second. Retain its
    // receipt beyond that boundary before pruning can make its id available.
    return Result.ok(
      new VerifiedDesktopDeviceProof({
        thumbprint,
        jti: payload.jti,
        expiresAt: new Date(
          (payload.iat + DESKTOP_PROOF_MAX_AGE_SECONDS + 1) * 1000,
        ),
        binding: verifiedBinding,
        nonce: payload.nonce,
      }),
    );
  }
}

export const desktopProofRequestUrl = (
  request: Request,
  publicOrigin: string,
) => {
  const target = new URL(publicOrigin);
  target.pathname = new URL(request.url).pathname;
  target.search = "";
  target.hash = "";
  return target.toString();
};
