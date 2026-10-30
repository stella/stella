import { APIError } from "better-auth/api";
import { Result } from "better-result";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { ORGANIZATION_SLUG_RULES } from "@stll/auth-model";
import { createTestState } from "@stll/test-state";

import { organization } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { auditLogs } from "@/api/db/schema";
import { env } from "@/api/env";
import { organizationsRoute } from "@/api/handlers/organizations/routes";
import { getAuth } from "@/api/lib/auth";
import { ORGANIZATION_SLUG_RATE_LIMIT } from "@/api/lib/rate-limit/organization-slug";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";

// timeout: real email-code sign-ins and organization writes use migrated Postgres.
setDefaultTimeout(120_000);

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const server = serveRoutesForTest(organizationsRoute);
const testState = createTestState({ file: import.meta.path, config: env });
const organizationIds = new Set<string>();
const slugAnswer = v.object({ slug: v.string() });

afterAll(async () => {
  await server.stop();
  for (const id of organizationIds) {
    await rootDb.delete(organization).where(eq(organization.id, id));
  }
});

const createOrganization = async () => {
  const owner = await signInHuman(
    `slug-owner-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const org = await getAuth().api.createOrganization({
    body: { name: "Slug update test", slug: `slug-${Bun.randomUUIDv7()}` },
    headers: owner.headers(),
  });
  organizationIds.add(org.id);
  await owner.setActiveOrganization(org.id);
  return { owner, org: { ...org, id: brandPersistedOrganizationId(org.id) } };
};

const addMember = async ({
  owner,
  organizationId,
  role,
}: {
  owner: HumanBrowser;
  organizationId: string;
  role: "admin" | "member";
}) => {
  const browser = await signInHuman(
    `slug-${role}-${Bun.randomUUIDv7()}@stella.dev`,
  );
  await getAuth().api.addMember({
    body: { organizationId, userId: browser.userId, role },
    headers: owner.headers(),
  });
  await browser.setActiveOrganization(organizationId);
  return browser;
};

const updateSlug = async (
  browser: HumanBrowser,
  body: { type: "explicit"; slug: string } | { type: "opaque" },
) =>
  await server.fetch(
    new Request("http://localhost/organizations/slug", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: browser.cookieHeader(),
      },
      body: JSON.stringify(body),
    }),
  );

describe.skipIf(!runPostgresTests)(
  "organization slug updates (postgres)",
  () => {
    for (const role of ["owner", "admin"] as const) {
      test(`${role} can update the slug with an attributed audit row`, async () => {
        const { owner, org } = await createOrganization();
        const browser =
          role === "owner"
            ? owner
            : await addMember({ owner, organizationId: org.id, role });
        const slug = `updated-${Bun.randomUUIDv7()}`;
        const response = await updateSlug(browser, { type: "explicit", slug });
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toEqual({ slug });
        expect(
          await rootDb
            .select({ slug: organization.slug })
            .from(organization)
            .where(eq(organization.id, org.id)),
        ).toEqual([{ slug }]);
        const audits = await rootDb
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, org.id));
        expect(audits).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              userId: browser.userId,
              resourceId: org.id,
              changes: { slug: { old: org.slug, new: slug } },
            }),
          ]),
        );
      });
    }

    test("an organization A member cannot change organization B's slug", async () => {
      const first = await createOrganization();
      const second = await createOrganization();
      const browser = await addMember({
        owner: first.owner,
        organizationId: first.org.id,
        role: "member",
      });
      const beforeAudit = await rootDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, second.org.id));
      const selectOtherOrganization = await getAuth().api.setActiveOrganization(
        {
          body: { organizationId: second.org.id },
          headers: browser.headers(),
          asResponse: true,
        },
      );
      expect(selectOtherOrganization.status).toBe(403);
      const slug = `isolated-${Bun.randomUUIDv7()}`;
      const response = await server.fetch(
        new Request("http://localhost/organizations/slug", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: browser.cookieHeader(),
          },
          body: JSON.stringify({
            type: "explicit",
            slug,
            organizationId: second.org.id,
          }),
        }),
      );
      expect(response.status).toBe(422);
      expect(
        (await updateSlug(browser, { type: "explicit", slug })).status,
      ).toBe(403);
      for (const { org } of [first, second]) {
        expect(
          await rootDb
            .select({ slug: organization.slug })
            .from(organization)
            .where(eq(organization.id, org.id)),
        ).toEqual([{ slug: org.slug }]);
      }
      expect(
        await rootDb
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, second.org.id)),
      ).toEqual(beforeAudit);
      const permitted = await updateSlug(second.owner, {
        type: "explicit",
        slug,
      });
      expect(permitted.status, await permitted.clone().text()).toBe(200);
      expect(
        await rootDb
          .select({ slug: organization.slug })
          .from(organization)
          .where(eq(organization.id, second.org.id)),
      ).toEqual([{ slug }]);
    });

    test("members cannot rename their organization", async () => {
      const { owner, org } = await createOrganization();
      const browser = await addMember({
        owner,
        organizationId: org.id,
        role: "member",
      });
      const beforeAudit = await rootDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, org.id));
      expect((await updateSlug(browser, { type: "opaque" })).status).toBe(403);
      expect(
        await rootDb
          .select({ slug: organization.slug })
          .from(organization)
          .where(eq(organization.id, org.id)),
      ).toEqual([{ slug: org.slug }]);
      expect(
        await rootDb
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, org.id)),
      ).toEqual(beforeAudit);
    });

    for (const account of ["review", "demo"] as const) {
      test(`${account} accounts cannot rename their organization`, async () => {
        const { owner, org } = await createOrganization();
        if (account === "review") {
          testState.setConfig("APP_REVIEW_ACCOUNT_EMAIL", owner.email);
          testState.setConfig("APP_REVIEW_ORGANIZATION_ID", org.id);
        } else {
          testState.setConfig("DEMO_ACCOUNT_EMAIL", owner.email);
          testState.setConfig("DEMO_ACCOUNT_ORGANIZATION_ID", org.id);
        }
        expect((await updateSlug(owner, { type: "opaque" })).status).toBe(403);
        expect(
          await rootDb
            .select({ slug: organization.slug })
            .from(organization)
            .where(eq(organization.id, org.id)),
        ).toEqual([{ slug: org.slug }]);
      });
    }

    test("direct auth slug updates are refused while name-only updates succeed", async () => {
      const { owner, org } = await createOrganization();
      const outcome = await Result.tryPromise(() =>
        getAuth().api.updateOrganization({
          body: {
            organizationId: org.id,
            data: { slug: `bypass-${Bun.randomUUIDv7()}` },
          },
          headers: owner.headers(),
        }),
      );
      expect(Result.isError(outcome)).toBe(true);
      if (Result.isError(outcome)) {
        expect(outcome.error.cause).toBeInstanceOf(APIError);
        expect(outcome.error.cause).toMatchObject({
          body: { code: "organization_slug_update_required" },
        });
      }
      expect(
        await rootDb
          .select({ slug: organization.slug })
          .from(organization)
          .where(eq(organization.id, org.id)),
      ).toEqual([{ slug: org.slug }]);
      const name = "Renamed organization";
      await getAuth().api.updateOrganization({
        body: { organizationId: org.id, data: { name } },
        headers: owner.headers(),
      });
      expect(
        await rootDb
          .select({ name: organization.name, slug: organization.slug })
          .from(organization)
          .where(eq(organization.id, org.id)),
      ).toEqual([{ name, slug: org.slug }]);
    });

    test("an existing slug returns a typed conflict without changing either organization", async () => {
      const first = await createOrganization();
      const second = await createOrganization();
      const response = await updateSlug(first.owner, {
        type: "explicit",
        slug: second.org.slug,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "organization_slug_conflict",
      });
      for (const { org } of [first, second]) {
        expect(
          await rootDb
            .select({ slug: organization.slug })
            .from(organization)
            .where(eq(organization.id, org.id)),
        ).toEqual([{ slug: org.slug }]);
      }
    });

    test("concurrent organizations claiming one unused slug have exactly one winner", async () => {
      const first = await createOrganization();
      const second = await createOrganization();
      const slug = `race-${Bun.randomUUIDv7()}`;
      expect(
        await rootDb
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.slug, slug)),
      ).toEqual([]);
      const outcomes = await Promise.all(
        [first, second].map(async (fixture) => ({
          fixture,
          response: await updateSlug(fixture.owner, { type: "explicit", slug }),
        })),
      );
      expect(
        outcomes.map(({ response }) => response.status).toSorted(),
      ).toEqual([200, 409]);
      for (const { fixture, response } of outcomes) {
        const persistedSlug = response.status === 200 ? slug : fixture.org.slug;
        if (response.status === 200) {
          expect(await response.json()).toEqual({ slug });
        } else {
          expect(await response.json()).toMatchObject({
            code: "organization_slug_conflict",
          });
        }
        expect(
          await rootDb
            .select({ slug: organization.slug })
            .from(organization)
            .where(eq(organization.id, fixture.org.id)),
        ).toEqual([{ slug: persistedSlug }]);
      }
    });

    for (const slug of [
      "",
      "a".repeat(ORGANIZATION_SLUG_RULES.maxLength + 1),
      "Uppercase",
      "with_underscore",
      "with space",
      "případ",
    ]) {
      test(`refuses invalid explicit slug ${JSON.stringify(slug)} without persistence`, async () => {
        const { owner, org } = await createOrganization();
        const response = await updateSlug(owner, { type: "explicit", slug });
        expect(response.status).toBe(422);
        expect(
          await rootDb
            .select({ slug: organization.slug })
            .from(organization)
            .where(eq(organization.id, org.id)),
        ).toEqual([{ slug: org.slug }]);
      });
    }

    test("opaque mode generates the public opaque slug format", async () => {
      const { owner } = await createOrganization();
      const response = await updateSlug(owner, { type: "opaque" });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(v.parse(slugAnswer, await response.json()).slug).toMatch(
        /^org-[a-z2-7]{10}$/u,
      );
    });

    test("owners and admins share one organization rate budget", async () => {
      expect(ORGANIZATION_SLUG_RATE_LIMIT).toMatchObject({
        max: 5,
        windowMs: 60_000,
      });
      const { owner, org } = await createOrganization();
      const admin = await addMember({
        owner,
        organizationId: org.id,
        role: "admin",
      });
      for (let index = 0; index < ORGANIZATION_SLUG_RATE_LIMIT.max; index++) {
        const response = await updateSlug(index % 2 === 0 ? owner : admin, {
          type: "opaque",
        });
        expect(response.status, await response.clone().text()).toBe(200);
      }
      expect((await updateSlug(admin, { type: "opaque" })).status).toBe(429);
      const other = await createOrganization();
      expect((await updateSlug(other.owner, { type: "opaque" })).status).toBe(
        200,
      );
    });
  },
);
