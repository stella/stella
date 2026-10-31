import { panic } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { createTestState } from "@stll/test-state";

import { member } from "@/api/db/auth-schema";
import { SETTING_USER_ID } from "@/api/db/rls";
import { rootDb } from "@/api/db/root";
import {
  accountAuditLogs,
  agentSkills,
  documentTypes,
  organizationAccessStates,
  organizationProfessionalUseAcceptances,
} from "@/api/db/schema";
import { env } from "@/api/env";
import createOrganization from "@/api/handlers/organizations/create";
import { organizationsRoute } from "@/api/handlers/organizations/routes";
import { HttpStatusResponse } from "@/api/http/status";
import { getAuth } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";

const testState = createTestState({ file: import.meta.path, config: env });
// timeout: Ten complete better-auth lifecycles seed document types and skills on PostgreSQL.
setDefaultTimeout(120_000);

const createdSchema = v.object({
  organizationId: v.string(),
  name: v.string(),
  slug: v.string(),
  role: v.literal("owner"),
});

const lifecycle = async (organizationId: SafeId<"organization">) => {
  const [access, professional, types, skills] = await Promise.all([
    rootDb
      .select({
        state: organizationAccessStates.state,
        origin: organizationAccessStates.origin,
      })
      .from(organizationAccessStates)
      .where(eq(organizationAccessStates.organizationId, organizationId)),
    rootDb
      .select({
        acceptedByUserId:
          organizationProfessionalUseAcceptances.acceptedByUserId,
        statementVersion:
          organizationProfessionalUseAcceptances.statementVersion,
        termsVersion: organizationProfessionalUseAcceptances.termsVersion,
      })
      .from(organizationProfessionalUseAcceptances)
      .where(
        eq(
          organizationProfessionalUseAcceptances.organizationId,
          organizationId,
        ),
      ),
    rootDb
      .select({
        key: documentTypes.key,
        label: documentTypes.label,
        sortOrder: documentTypes.sortOrder,
      })
      .from(documentTypes)
      .where(eq(documentTypes.organizationId, organizationId))
      .orderBy(documentTypes.key),
    rootDb
      .select({
        slug: agentSkills.slug,
        origin: agentSkills.origin,
        scope: agentSkills.scope,
        enabled: agentSkills.enabled,
        body: agentSkills.body,
      })
      .from(agentSkills)
      .where(eq(agentSkills.organizationId, organizationId))
      .orderBy(agentSkills.slug),
  ]);
  return { access, professional, types, skills };
};

const createRequest = ({
  browser,
  name,
  slug,
  key,
}: {
  browser: HumanBrowser;
  name: string;
  slug?: string;
  key?: string;
}) =>
  new Request("http://localhost/organizations", {
    method: "POST",
    headers: {
      cookie: browser.cookieHeader(),
      "content-type": "application/json",
      origin: "http://localhost:3000",
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    body: JSON.stringify({ name, ...(slug === undefined ? {} : { slug }) }),
  });

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "organization creation through the shared handler on PostgreSQL",
  () => {
    test("creates an owner with onboarding defaults, opaque slugs, replayed retries and account audit", async () => {
      const suffix = Bun.randomUUIDv7();
      const browser = await signInHuman(
        `organization-create-${suffix}@example.test`,
      );
      const baseline = await getAuth().api.createOrganization({
        headers: browser.headers(),
        body: {
          name: "Baseline organization",
          slug: `baseline-${suffix}`,
          keepCurrentActiveOrganization: true,
        },
      });
      if (baseline === null) {
        panic("Onboarding baseline organization required");
      }
      await using api = serveRoutesForTest(organizationsRoute);
      const input = {
        browser,
        name: `  Shared ${suffix}  `,
        key: `org-create-${suffix}`,
      };
      const response = await api.fetch(createRequest(input));
      expect(response.status, await response.clone().text()).toBe(200);
      const created = v.parse(createdSchema, await response.json());
      expect(created.name).toBe(`Shared ${suffix}`);
      expect(created.role).toBe("owner");
      expect(created.slug).toMatch(/^org-[a-z2-7]{10}$/u);
      expect(created.slug).not.toContain(suffix);
      const organizationId = brandPersistedOrganizationId(
        created.organizationId,
      );
      expect(
        await rootDb
          .select({ role: member.role })
          .from(member)
          .where(
            and(
              eq(member.organizationId, organizationId),
              eq(member.userId, brandPersistedUserId(browser.userId)),
            ),
          ),
      ).toEqual([{ role: "owner" }]);
      const actual = await lifecycle(organizationId);
      const expected = await lifecycle(
        brandPersistedOrganizationId(baseline.id),
      );
      expect(expected.access).toHaveLength(1);
      expect(expected.professional).toHaveLength(1);
      expect(expected.types.length).toBeGreaterThan(0);
      expect(expected.skills.length).toBeGreaterThan(0);
      expect(actual).toEqual(expected);
      const retried = await api.fetch(createRequest(input));
      expect(retried.status, await retried.clone().text()).toBe(200);
      expect(v.parse(createdSchema, await retried.json())).toEqual(created);
      const audit = await rootDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config(${SETTING_USER_ID}, ${browser.userId}, true)`,
        );
        return await tx
          .select({ eventType: accountAuditLogs.eventType })
          .from(accountAuditLogs)
          .where(
            and(
              eq(accountAuditLogs.userId, brandPersistedUserId(browser.userId)),
              eq(accountAuditLogs.resourceId, created.organizationId),
            ),
          );
      });
      expect(audit).toEqual([{ eventType: "organization.created" }]);
      const collision = await api.fetch(
        createRequest({ browser, name: `Shared ${suffix}` }),
      );
      expect(collision.status, await collision.clone().text()).toBe(200);
      const second = v.parse(createdSchema, await collision.json());
      expect(second.organizationId).not.toBe(created.organizationId);
      expect(second.slug).toMatch(/^org-[a-z2-7]{10}$/u);
      expect(second.slug).not.toBe(created.slug);
      expect(second.slug).not.toContain(suffix);
      const explicitSlug = `custom-${suffix}`;
      const explicit = await api.fetch(
        createRequest({
          browser,
          name: "Explicit organization",
          slug: explicitSlug,
        }),
      );
      expect(explicit.status, await explicit.clone().text()).toBe(200);
      expect(v.parse(createdSchema, await explicit.json()).slug).toBe(
        explicitSlug,
      );
      const conflictInput = {
        browser,
        name: "Explicit conflict",
        slug: created.slug,
        key: `conflict-${suffix}`,
      };
      for (const request of [
        createRequest(conflictInput),
        createRequest(conflictInput),
      ]) {
        const explicitConflict = await api.fetch(request);
        expect(explicitConflict.status).toBe(409);
        expect(await explicitConflict.json()).toMatchObject({
          code: "organization_slug_conflict",
        });
      }
      const reused = await api.fetch(
        createRequest({ ...input, name: "Different request" }),
      );
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({
        code: "idempotency_key_reused",
      });
    });

    test("replay receipts remain isolated between authenticated accounts", async () => {
      const suffix = Bun.randomUUIDv7();
      const first = await signInHuman(
        `organization-first-${suffix}@example.test`,
      );
      const second = await signInHuman(
        `organization-second-${suffix}@example.test`,
      );
      await using api = serveRoutesForTest(organizationsRoute);
      const createFor = async (browser: HumanBrowser) => {
        const response = await api.fetch(
          createRequest({
            browser,
            name: "Same organization request",
            key: `shared-${suffix}`,
          }),
        );
        expect(response.status, await response.clone().text()).toBe(200);
        return v.parse(createdSchema, await response.json());
      };
      const firstCreated = await createFor(first);
      const secondCreated = await createFor(second);
      expect(firstCreated.organizationId).not.toBe(
        secondCreated.organizationId,
      );
      expect(await createFor(first)).toEqual(firstCreated);
      expect(await createFor(second)).toEqual(secondCreated);
    });

    test("refuses the eleventh creation with the typed rate limit response", async () => {
      const browser = await signInHuman(
        `organization-budget-${Bun.randomUUIDv7()}@example.test`,
      );
      await using api = serveRoutesForTest(organizationsRoute);
      for (let index = 0; index < 10; index += 1) {
        const response = await api.fetch(
          createRequest({ browser, name: `Budget ${browser.userId} ${index}` }),
        );
        expect(response.status, await response.clone().text()).toBe(200);
      }
      const refused = await api.fetch(
        createRequest({ browser, name: "Budget overflow" }),
      );
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ code: "rate_limited" });
    });

    test("an OAuth token without the account creation scope cannot create an organization", async () => {
      const browser = await signInHuman(
        `organization-scope-${Bun.randomUUIDv7()}@example.test`,
      );
      const body = { name: `Scope ${browser.userId}` };
      const context = createTestHandlerContext<
        Parameters<typeof createOrganization.handler>[0]
      >({
        audit: NO_AUDIT,
        safeDb: NO_DB,
        scopedDb: NO_DB,
        user: {
          id: brandPersistedUserId(browser.userId),
          email: browser.email,
        },
        body,
        accountAuthority: {
          credential: {
            type: "oauth_client",
            clientId: "organization-create-scope-test",
          },
          grantedScopes: ["stella:read", "stella:write"],
        },
      });
      const refused = await createOrganization.handler(context);
      expect(refused).toBeInstanceOf(HttpStatusResponse);
      if (!(refused instanceof HttpStatusResponse)) {
        panic("Missing account scope must be refused");
      }
      expect(refused.code).toBe(403);
      expect(refused.response).toMatchObject({ code: "missing_scope" });
      const admitted = await createOrganization.handler({
        ...context,
        accountAuthority: {
          credential: {
            type: "oauth_client",
            clientId: "organization-create-scope-test",
          },
          grantedScopes: ["stella:organization_create"],
        },
      });
      expect(admitted).not.toBeInstanceOf(HttpStatusResponse);
      expect(v.parse(createdSchema, admitted).name).toBe(body.name);
    });

    test("demo and review accounts receive the documented account refusal", async () => {
      const email = "organization-refused@example.test";
      const id = brandPersistedUserId("organization_refused_fixture");
      const invoke = async () =>
        await createOrganization.handler(
          createTestHandlerContext<
            Parameters<typeof createOrganization.handler>[0]
          >({
            audit: NO_AUDIT,
            safeDb: NO_DB,
            scopedDb: NO_DB,
            user: { id, email },
            body: { name: "Refused organization" },
          }),
        );
      testState.setConfig("DEMO_ACCOUNT_EMAIL", email);
      const demo = await invoke();
      expect(demo).toBeInstanceOf(HttpStatusResponse);
      if (!(demo instanceof HttpStatusResponse)) {
        panic("Demo account must be refused");
      }
      expect(demo.response).toMatchObject({
        code: "account_access_unavailable",
      });
      testState.setConfig("DEMO_ACCOUNT_EMAIL", undefined);
      testState.setConfig("APP_REVIEW_ACCOUNT_EMAIL", email);
      testState.setConfig(
        "APP_REVIEW_ORGANIZATION_ID",
        brandPersistedOrganizationId("review_organization_fixture"),
      );
      const review = await invoke();
      expect(review).toBeInstanceOf(HttpStatusResponse);
      if (!(review instanceof HttpStatusResponse)) {
        panic("Review account must be refused");
      }
      expect(review.response).toMatchObject({
        code: "account_access_unavailable",
      });
    });
  },
);
