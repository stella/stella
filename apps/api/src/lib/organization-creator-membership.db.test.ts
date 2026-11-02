import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { organizationsRoute } from "@/api/handlers/organizations/routes";
import { getAuth } from "@/api/lib/auth";
import {
  createHumanSession,
  signInHuman,
} from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let database: TestDatabase;
const getDatabase = () => database;
beforeAll(async () => {
  database = await initAgentAuthTestDb();
}, 120_000);
afterAll(async () => {
  await releaseAgentAuthTestDb();
});

describe("organization creator membership", () => {
  test("browser creation persists exactly one owner", async () => {
    const db = getDatabase();
    const browser = await signInHuman(
      `creator-browser-${Bun.randomUUIDv7()}@stella.dev`,
    );
    await using api = serveRoutesForTest(organizationsRoute);
    const slug = `creator-browser-${Bun.randomUUIDv7()}`;
    const headers = browser.headers();
    headers.set("content-type", "application/json");
    headers.set("origin", "http://localhost:3000");
    const response = await api.fetch(
      new Request("http://localhost/organizations", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Creator membership",
          slug,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const org = await db.query.organization.findFirst({
      where: { slug: { eq: slug } },
    });
    expect(org).toBeDefined();
    if (!org) {
      throw new TypeError(
        "Successful organization creation must persist its organization",
      );
    }
    expect(
      await db
        .select({ role: member.role, userId: member.userId })
        .from(member)
        .where(eq(member.organizationId, org.id)),
    ).toEqual([{ role: "owner", userId: browser.userId }]);
  }, 120_000);

  test("system userId creation without session headers persists exactly one owner", async () => {
    const db = getDatabase();
    const userId = Bun.randomUUIDv7();
    await db.insert(user).values({
      id: userId,
      name: "System creator",
      email: `creator-system-${userId}@stella.dev`,
    });
    const org = await getAuth().api.createOrganization({
      body: {
        name: "Creator membership",
        slug: `creator-system-${Bun.randomUUIDv7()}`,
        userId,
        keepCurrentActiveOrganization: true,
      },
    });
    expect(
      await db
        .select({ role: member.role, userId: member.userId })
        .from(member)
        .where(eq(member.organizationId, org.id)),
    ).toEqual([{ role: "owner", userId }]);
  }, 120_000);

  test("the human-session helper creates and activates one owner membership", async () => {
    const session = await createHumanSession({
      email: `creator-helper-${Bun.randomUUIDv7()}@stella.dev`,
      orgName: "Creator membership",
      orgSlugPrefix: "creator-helper",
    });
    expect(
      await getDatabase()
        .select({ role: member.role, userId: member.userId })
        .from(member)
        .where(eq(member.organizationId, session.organizationId)),
    ).toEqual([{ role: "owner", userId: session.userId }]);
    const active = await getAuth().api.getSession({
      headers: session.browser.headers(),
    });
    expect(active?.session.activeOrganizationId).toBe(session.organizationId);
  }, 120_000);
});
