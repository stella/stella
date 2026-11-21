import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@stll/api-contract/professional-use";

import { session } from "@/api/db/auth-schema";
import { userProfessionalUseAcceptances } from "@/api/db/schema";
import { mintSmokeSession } from "@/api/lib/smoke-session/store";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

test("minting a smoke session creates its principal's missing professional-use acceptance", async () => {
  expect(await testDb.select().from(userProfessionalUseAcceptances)).toEqual(
    [],
  );

  const minted = await mintSmokeSession("default");
  const token = minted.cookieValue.slice(0, minted.cookieValue.indexOf("."));

  const sessions = await testDb
    .select({ token: session.token, expiresAt: session.expiresAt })
    .from(session)
    .where(eq(session.token, token));
  expect(sessions).toEqual([{ token, expiresAt: new Date(minted.expiresAt) }]);

  const acceptances = await testDb
    .select({
      statementVersion: userProfessionalUseAcceptances.statementVersion,
      termsVersion: userProfessionalUseAcceptances.termsVersion,
    })
    .from(userProfessionalUseAcceptances)
    .innerJoin(
      session,
      eq(session.userId, userProfessionalUseAcceptances.userId),
    )
    .where(eq(session.token, token));
  expect(acceptances).toEqual([
    {
      statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
      termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
    },
  ]);
});
