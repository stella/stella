import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { session } from "@/api/db/auth-schema";
import { syntheticSessionControl } from "@/api/db/schema";
import { presignDownloadUrl } from "@/api/lib/s3-presign";
import type { PresignDownloadOptions } from "@/api/lib/s3-presign";
import {
  SYNTHETIC_PRINCIPAL,
  SYNTHETIC_SESSION_CONTROL_ID,
} from "@/api/lib/synthetic-principal/constants";
import { readSyntheticSessionAuthority } from "@/api/lib/synthetic-principal/session-authority";
import {
  refusedCredentialIssuerProbes,
  syntheticCredentialPrincipal,
} from "@/api/tests/helpers/session-credential-issuer-probes";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import { USER_SESSION_CREDENTIAL_ISSUERS } from "./credential-policy";
import { createSyntheticSessionStore } from "./store";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
beforeAll(async () => {
  fixture = await getRlsFixture();
});
afterAll(async () => {
  await releaseRlsFixture();
});

for (const [issuer, probe] of Object.entries(refusedCredentialIssuerProbes)) {
  test(`refuses the ${issuer} issuer for the synthetic principal`, async () => {
    await probe(syntheticCredentialPrincipal);
  });
}

test("classifies signed downloads as session-bound with a short lifetime", () => {
  expect(USER_SESSION_CREDENTIAL_ISSUERS.signedDownload).toEqual({
    disposition: "session-bound-ttl",
    maxTtlSeconds: 60,
    owner: "s3-presign",
  });
  expect(USER_SESSION_CREDENTIAL_ISSUERS.signedUpload.disposition).toBe(
    "refused",
  );
});

test("revoking a dedicated session refuses new signed downloads", async () => {
  const { testDb } = fixture;
  const store = createSyntheticSessionStore(asTestRaw(testDb));
  await store.revokeSyntheticSessions();
  await testDb
    .insert(syntheticSessionControl)
    .values({ id: SYNTHETIC_SESSION_CONTROL_ID, status: "enabled" })
    .onConflictDoUpdate({
      target: syntheticSessionControl.id,
      set: { status: "enabled" },
    });
  await store.mintSyntheticSession({
    keyLabel: "credential-issuer-test",
    requestId: undefined,
    userAgent: null,
  });
  const source = (
    await testDb
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, SYNTHETIC_PRINCIPAL.user.id))
      .limit(1)
  ).at(0);
  expect(source).toBeDefined();
  if (!source) {
    return;
  }
  const options = {
    userId: SYNTHETIC_PRINCIPAL.user.id,
    organizationId: SYNTHETIC_PRINCIPAL.org.id,
    expiresIn: 900,
    source: { kind: "request", sessionId: source.id },
    readSessionAuthority: async (authority: {
      sessionId: string | null;
      userId: string;
      now?: Date;
    }) => await readSyntheticSessionAuthority(testDb, authority),
    scope: { organizationId: SYNTHETIC_PRINCIPAL.org.id },
  } satisfies PresignDownloadOptions;
  const issued = await presignDownloadUrl(
    `${SYNTHETIC_PRINCIPAL.org.id}/seed.docx`,
    options,
  );
  expect(
    Number(new URL(issued).searchParams.get("X-Amz-Expires")),
  ).toBeLessThanOrEqual(60);

  await store.revokeSyntheticSessions();
  expect(
    await rejectionOf(
      presignDownloadUrl(`${SYNTHETIC_PRINCIPAL.org.id}/seed.docx`, options),
    ),
  ).toMatchObject({
    status: 403,
    code: "account_access_unavailable",
  });
});
