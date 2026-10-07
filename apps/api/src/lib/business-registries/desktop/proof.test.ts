import { defaultKeyHasher } from "@better-auth/api-key";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { createHash } from "node:crypto";

import { VerifiedDesktopDeviceProof } from "./proof";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const IAT = NOW.getTime() / 1000;
const URL = "https://api.example.test/v1/desktop-account/renew";
const CREDENTIAL = `stella_dr_${"1".repeat(128)}`;
const ATH = createHash("sha256").update(CREDENTIAL).digest("base64url");

const DEFAULT_ACCOUNT_BINDING = {
  type: "account",
  keyId: "fixture-key",
  credential: CREDENTIAL,
} as const;

const fixture = async () => {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  const thumbprint = await calculateJwkThumbprint(jwk);
  const sign = async (
    payload: Record<string, unknown>,
    header: Record<string, unknown> = {},
  ) =>
    await new SignJWT(payload)
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk, ...header })
      .sign(keys.privateKey);
  const verify = async (
    compact: string,
    binding:
      | { type: "account"; keyId: string; credential: string }
      | { type: "link"; nonce: string } = DEFAULT_ACCOUNT_BINDING,
  ) =>
    await VerifiedDesktopDeviceProof.verify({
      request: new Request(`${URL}?view=one`, {
        method: "POST",
        headers: { DPoP: compact },
      }),
      expectedUrl: `${URL}?view=one#fragment`,
      expectedThumbprint: thumbprint,
      binding,
      now: NOW,
    });
  return { keys, jwk, thumbprint, sign, verify };
};

const claims = () => ({
  htm: "POST",
  htu: URL,
  iat: IAT,
  jti: Bun.randomUUIDv7(),
  ath: ATH,
});
type ProofResult = Awaited<
  ReturnType<typeof VerifiedDesktopDeviceProof.verify>
>;
const expectRefusal = (result: ProofResult, code = "desktop_proof_invalid") => {
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toMatchObject({ status: 401, code, retryable: false });
  }
};

describe("desktop account request proofs", () => {
  test("a signed account proof binds the exact credential, key ID, device and canonical URL", async () => {
    const { sign, verify, thumbprint } = await fixture();
    const payload = claims();
    const result = await verify(await sign(payload));
    if (result.isErr()) {
      panic(result.error.message);
    }
    expect(result.value).toBeInstanceOf(VerifiedDesktopDeviceProof);
    expect(result.value).toMatchObject({
      thumbprint,
      jti: payload.jti,
      expiresAt: new Date(NOW.getTime() + 61_000),
      binding: {
        type: "account",
        keyId: "fixture-key",
        credentialHash: await defaultKeyHasher(CREDENTIAL),
      },
    });
  });

  test("signed request identifiers accept native UUIDv4 and Bun UUIDv7", async () => {
    const { sign, verify } = await fixture();
    for (const jti of [
      "c6d52de3-0674-4d2e-8dfb-a8cf5f692096",
      Bun.randomUUIDv7(),
    ]) {
      const result = await verify(await sign({ ...claims(), jti }));
      if (result.isErr()) {
        panic(result.error.message);
      }
      expect(result.value.jti).toBe(jti);
    }
  });

  test("initial linking requires the signed grant nonce and excludes a credential hash", async () => {
    const { sign, verify } = await fixture();
    const { ath: _ath, ...payload } = claims();
    const compact = await sign({ ...payload, nonce: "fixture-grant" });
    const result = await verify(compact, {
      type: "link",
      nonce: "fixture-grant",
    });
    if (result.isErr()) {
      panic(result.error.message);
    }
    expect(result.value.binding).toEqual({
      type: "link",
      nonce: "fixture-grant",
    });
    expectRefusal(
      await verify(compact, { type: "link", nonce: "other-grant" }),
    );
    expectRefusal(
      await verify(
        await sign({ ...payload, nonce: "fixture-grant", ath: ATH }),
        { type: "link", nonce: "fixture-grant" },
      ),
    );
    expectRefusal(
      await verify(await sign(payload), {
        type: "link",
        nonce: "fixture-grant",
      }),
    );
  });

  test("another signing device cannot claim the bound device identity", async () => {
    const expected = await fixture();
    const other = await fixture();
    expect(other.thumbprint).not.toBe(expected.thumbprint);
    expectRefusal(
      await expected.verify(await other.sign(claims())),
      "desktop_device_mismatch",
    );
  });

  test("the freshness window includes its whole final second and permits only bounded future skew", async () => {
    const { sign, verify, thumbprint } = await fixture();
    for (const elapsed of [-5, 0, 59, 60]) {
      const result = await verify(
        await sign({ ...claims(), iat: IAT - elapsed }),
      );
      expect(result.isOk()).toBe(true);
    }
    for (const elapsed of [-6, 61]) {
      expectRefusal(
        await verify(await sign({ ...claims(), iat: IAT - elapsed })),
        "desktop_proof_expired",
      );
    }
    const result = await VerifiedDesktopDeviceProof.verify({
      request: new Request(URL, {
        method: "POST",
        headers: { DPoP: await sign({ ...claims(), iat: IAT - 60 }) },
      }),
      expectedUrl: URL,
      expectedThumbprint: thumbprint,
      binding: {
        type: "account",
        keyId: "fixture-key",
        credential: CREDENTIAL,
      },
      now: new Date(NOW.getTime() + 999),
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.expiresAt).toEqual(new Date(NOW.getTime() + 1000));
    }
  });

  test("method, endpoint and exact presented credential are all required", async () => {
    const { sign, verify } = await fixture();
    const { ath: _ath, ...withoutAth } = claims();
    for (const payload of [
      { ...claims(), htm: "GET" },
      { ...claims(), htm: "post" },
      {
        ...claims(),
        htu: URL.replace("api.example.test", "other.example.test"),
      },
      { ...claims(), htu: `${URL}/` },
      { ...claims(), htu: `${URL}?view=one` },
      { ...claims(), htu: `${URL}#fragment` },
      {
        ...claims(),
        ath: createHash("sha256").update(`${CREDENTIAL} `).digest("base64url"),
      },
      withoutAth,
    ]) {
      expectRefusal(await verify(await sign(payload)));
    }
    expectRefusal(
      await verify(await sign(claims()), {
        type: "account",
        keyId: "fixture-key",
        credential: `${CREDENTIAL} `,
      }),
    );
  });

  test("malformed claims, a wrong proof type and malformed headers fail closed", async () => {
    const { sign, verify } = await fixture();
    for (const payload of [
      { ...claims(), iat: IAT + 0.5 },
      { ...claims(), iat: -1 },
      { ...claims(), iat: "now" },
      { ...claims(), jti: "not-a-uuid" },
      { ...claims(), ath: "short" },
    ]) {
      expectRefusal(await verify(await sign(payload)));
    }
    expectRefusal(await verify(await sign(claims(), { typ: "JWT" })));
    const compact = await sign(claims());
    for (const invalid of [
      "",
      "not-a-jws",
      `${compact}, ${compact}`,
      "A".repeat(4097),
    ]) {
      expectRefusal(await verify(invalid));
    }
  });
});
