import { panic } from "better-result";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";

import { apikey } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { apiKeysRoute } from "@/api/handlers/api-keys/routes";
import { getAuth } from "@/api/lib/auth";
import { signInHuman } from "@/api/tests/helpers/human-session";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";

// timeout: a real email-code sign-in and key routes run against the migrated server.
setDefaultTimeout(120_000);

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

let createdUserId: string | undefined;

// The key routes over a real socket, behind the API's own pipeline.
const server = serveRoutesForTest(apiKeysRoute);

afterAll(async () => {
  await server.stop();
  if (createdUserId === undefined) {
    return;
  }
  await rootDb.delete(apikey).where(eq(apikey.referenceId, createdUserId));
});

const createPersonalKey = async (cookie: string, name: string) =>
  await server.fetch(
    new Request("http://localhost/api-keys/personal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ expiresInDays: 1, name }),
    }),
  );

describe.skipIf(!runPostgresTests)("personal API keys (postgres)", () => {
  test("a revoked cached session cannot mint a durable API key", async () => {
    const email = `revoked-key-${Bun.randomUUIDv7()}@stella.dev`;
    const revokedBrowser = await signInHuman(email);
    createdUserId = revokedBrowser.userId;

    const organization = await getAuth().api.createOrganization({
      body: {
        name: "Revoked API key session",
        slug: `revoked-key-${Bun.randomUUIDv7()}`,
      },
      headers: revokedBrowser.headers(),
    });
    await revokedBrowser.setActiveOrganization(organization.id);

    const currentBrowser = await signInHuman(email);
    await currentBrowser.setActiveOrganization(organization.id);

    const revokedSession = await getAuth().api.getSession({
      headers: revokedBrowser.headers(),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    const revokedSessionId =
      revokedSession?.session.id ?? panic("The first browser has no session");

    const primed = await getAuth().api.getSession({
      asResponse: true,
      headers: revokedBrowser.headers(),
    });
    expect(primed.status).toBe(200);

    await getAuth().api.revokeSessionById({
      body: { sessionId: revokedSessionId },
      headers: currentBrowser.headers(),
    });

    const rejected = await createPersonalKey(
      revokedBrowser.cookieHeader(),
      "revoked-browser",
    );
    expect(rejected.status).toBe(401);
    expect(
      await rootDb
        .select({ id: apikey.id })
        .from(apikey)
        .where(eq(apikey.referenceId, revokedBrowser.userId)),
    ).toEqual([]);

    const accepted = await createPersonalKey(
      currentBrowser.cookieHeader(),
      "current-browser",
    );
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(
      await rootDb
        .select({ id: apikey.id })
        .from(apikey)
        .where(eq(apikey.referenceId, revokedBrowser.userId)),
    ).toHaveLength(1);
  });
});
