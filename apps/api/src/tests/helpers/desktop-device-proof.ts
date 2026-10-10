import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";

import { sha256Base64Url } from "@stll/sha256/bun";

import { desktopDeviceProofReplays } from "@/api/db/schema/desktop-device-proof-replay";
import { env } from "@/api/env";
import {
  DESKTOP_PROOF_HEADER,
  VerifiedDesktopDeviceProof,
  desktopProofRequestUrl,
} from "@/api/lib/business-registries/desktop/proof";
import { ConsumedDesktopDeviceProof } from "@/api/lib/business-registries/desktop/proof-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type SignedRequestOptions = {
  request: Request;
  credential?: string;
  nonce?: string;
};

export const createDesktopDeviceSigner = async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const deviceJkt = await calculateJwkThumbprint(jwk, "sha256");
  const signRequest = async ({
    request,
    credential,
    nonce,
  }: SignedRequestOptions) => {
    const proof = await new SignJWT({
      htm: request.method,
      htu: desktopProofRequestUrl(
        request,
        env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
      ),
      ...(credential === undefined ? {} : { ath: sha256Base64Url(credential) }),
      ...(nonce === undefined ? {} : { nonce }),
    })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk })
      .setIssuedAt()
      .setJti(Bun.randomUUIDv7())
      .sign(privateKey);
    const signed = new Request(request);
    signed.headers.set(DESKTOP_PROOF_HEADER, proof);
    return signed;
  };
  return { deviceJkt, signRequest };
};

type ClaimFixtureProofOptions = {
  request: Request;
  deviceJkt: string;
  keyId: string;
  credential: string;
};

// Handler fixtures own no database. Exercise signature verification and receipt
// construction, replacing only the replay store's persistence boundary.
export const claimFixtureDeviceProof = async ({
  request,
  deviceJkt,
  keyId,
  credential,
}: ClaimFixtureProofOptions) => {
  const verified = await VerifiedDesktopDeviceProof.verify({
    request,
    expectedUrl: desktopProofRequestUrl(
      request,
      env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
    ),
    expectedThumbprint: deviceJkt,
    binding: { type: "account", keyId, credential },
  });
  if (verified.isErr()) {
    panic("Fixture device proof must verify");
  }
  const selectQuery = drizzle
    .mock()
    .select()
    .from(desktopDeviceProofReplays)
    .where(sql`true`);
  const emptyBatch = {
    toSQL: () => selectQuery.toSQL(),
    limit: () => ({ for: async () => Promise.resolve([]) }),
  };
  const db = asTestRaw<
    NonNullable<Parameters<typeof ConsumedDesktopDeviceProof.claim>[0]["db"]>
  >({
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      await callback({
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({ $dynamic: () => emptyBatch }),
              }),
            }),
          }),
        }),
        delete: () => ({
          where: () => ({ returning: async () => Promise.resolve([]) }),
        }),
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({
              returning: async () =>
                Promise.resolve([{ jti: verified.value.jti }]),
            }),
          }),
        }),
      }),
  });
  const receipt = await ConsumedDesktopDeviceProof.claim({
    proof: verified.value,
    db,
  });
  if (receipt.isErr()) {
    panic("Fixture device proof must be claimed");
  }
  return receipt.value;
};
