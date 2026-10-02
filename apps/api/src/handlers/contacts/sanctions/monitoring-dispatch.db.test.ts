import { panic } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { roles } from "@stll/permissions";
import { SANCTIONS_SOURCES } from "@stll/sanctions";

import { member } from "@/api/db/auth-schema";
import type { contacts } from "@/api/db/schema";
import {
  auditLogs,
  organizationSettings,
  sanctionsOrganizationMarks,
  sanctionsSources,
} from "@/api/db/schema";
import { contactsRoute } from "@/api/handlers/contacts/routes";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { getAuth } from "@/api/lib/auth";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import { MCP_DEFAULT_RESOURCE_SCOPES } from "@/api/mcp/constants";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import {
  createHumanSession,
  signInHuman,
} from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);
let db: TestDatabase;
beforeAll(async () => {
  db = await initAgentAuthTestDb();
  await db
    .insert(sanctionsSources)
    .values(
      sanctionsSourceIds().map((id) => ({
        id,
        issuer: SANCTIONS_SOURCES[id].issuer,
        markerUrl: "https://example.test/sanctions",
      })),
    )
    .onConflictDoNothing();
});
afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const transports = ["http", "mcp"] as const;
type Transport = (typeof transports)[number];
const roleNames = Object.keys(roles).filter(isMemberRole);

const caller = async (role: MemberRole) => {
  const owner = await createHumanSession({
    email: `monitor-owner-${Bun.randomUUIDv7()}@stella.dev`,
    orgName: "Monitoring dispatch",
    orgSlugPrefix: "monitor-dispatch",
  });
  const organizationId = toSafeId<"organization">(owner.organizationId);
  if (role === "owner") {
    return { browser: owner.browser, organizationId };
  }
  const browser = await signInHuman(
    `monitor-${role}-${Bun.randomUUIDv7()}@stella.dev`,
  );
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId: toSafeId<"user">(browser.userId),
    role,
    createdAt: new Date(),
  });
  await browser.setActiveOrganization(organizationId);
  return { browser, organizationId };
};

type DispatchOptions = {
  transport: Transport;
  browser: HumanBrowser;
  capability:
    | "organization-settings.sanctions-monitoring.update"
    | "contacts.sanctions.monitoring.update";
  mode: string;
  contactId?: typeof contacts.$inferSelect.id;
};
const dispatch = async ({
  transport,
  browser,
  capability,
  mode,
  contactId,
}: DispatchOptions) => {
  if (transport === "http") {
    const route =
      contactId === undefined ? organizationSettingsRoute : contactsRoute;
    const path =
      contactId === undefined
        ? "/organization-settings/sanctions-monitoring"
        : `/contacts/${contactId}/sanctions/monitoring`;
    const response = await route.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          cookie: browser.cookieHeader(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode }),
      }),
    );
    return {
      ok: response.ok,
      status: response.status,
      payload: await response.json(),
    };
  }
  const session = await getAuth().api.getSession({
    headers: browser.headers(),
    query: { disableCookieCache: true },
  });
  if (!session?.session.activeOrganizationId) {
    panic("Authenticated session missing active organization");
  }
  const context = await resolveMcpSessionContext(
    {
      userId: session.user.id,
      organizationId: session.session.activeOrganizationId,
      scopes: [...MCP_DEFAULT_RESOURCE_SCOPES],
      credential: { type: "delegated_user" },
    },
    { request: new Request("http://localhost/mcp", { method: "POST" }) },
  );
  const result = await handleMcpToolCall({
    toolName: "invoke_capability",
    context,
    args: {
      capability,
      confirm: true,
      input: {
        body: { mode },
        ...(contactId === undefined ? {} : { params: { contactId } }),
      },
    },
  });
  const text = result.content.at(0);
  if (text?.type !== "text") {
    panic("MCP dispatch must return text evidence");
  }
  const payload: unknown = JSON.parse(text.text);
  return { ok: result.isError !== true, status: undefined, payload };
};

const firmState = async (
  organizationId: typeof organizationSettings.$inferSelect.organizationId,
) => ({
  settings: await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId)),
  marks: await db
    .select()
    .from(sanctionsOrganizationMarks)
    .where(eq(sanctionsOrganizationMarks.organizationId, organizationId)),
  audits: await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.resourceId, organizationId),
      ),
    )
    .orderBy(auditLogs.createdAt, auditLogs.id),
});

test("firm monitoring changes require the firm-settings grant in HTTP and MCP", async () => {
  expect(roleNames.toSorted()).toEqual(Object.keys(roles).toSorted());
  expect(roles.member.authorize({ contact: ["update"] }).success).toBe(true);
  expect(
    roles.member.authorize({ organizationSettings: ["update"] }).success,
  ).toBe(false);
  for (const transport of transports) {
    for (const role of roleNames) {
      const { browser, organizationId } = await caller(role);
      const allowed = roles[role].authorize({
        organizationSettings: ["update"],
      }).success;
      await db
        .insert(organizationSettings)
        .values({
          id: createSafeId<"organizationSettings">(),
          organizationId,
          sanctionsMonitoringMode: "enabled",
        })
        .onConflictDoUpdate({
          target: organizationSettings.organizationId,
          set: { sanctionsMonitoringMode: "enabled" },
        });
      await db
        .delete(sanctionsOrganizationMarks)
        .where(eq(sanctionsOrganizationMarks.organizationId, organizationId));
      const before = await firmState(organizationId);
      for (const mode of ["disabled", "enabled"] as const) {
        const response = await dispatch({
          transport,
          browser,
          capability: "organization-settings.sanctions-monitoring.update",
          mode,
        });
        expect(
          response.ok,
          `${transport}/${role}/${mode}: ${JSON.stringify(response.payload)}`,
        ).toBe(allowed);
        if (!allowed) {
          if (transport === "http") {
            expect(response.status).toBe(403);
          } else {
            expect(response.payload).toMatchObject({
              error: { code: "permission_denied" },
            });
          }
          expect(await firmState(organizationId)).toEqual(before);
          continue;
        }
        expect(response.payload).toMatchObject(
          transport === "http" ? { mode } : { result: { mode } },
        );
        const after = await firmState(organizationId);
        expect(after.settings).toHaveLength(1);
        expect(after.settings.at(0)?.sanctionsMonitoringMode).toBe(mode);
        const newAudits = after.audits.filter(
          (audit) =>
            !before.audits.some((previous) => previous.id === audit.id),
        );
        expect(newAudits).toHaveLength(mode === "disabled" ? 1 : 2);
        expect(newAudits.at(-1)).toMatchObject({
          userId: browser.userId,
          organizationId,
          workspaceId: null,
          action: "update",
          resourceId: organizationId,
          changes: {
            sanctionsMonitoringMode: {
              old: mode === "disabled" ? "enabled" : "disabled",
              new: mode,
            },
          },
        });
        expect(after.marks).toHaveLength(1);
        expect(after.marks.at(0)?.organizationId).toBe(organizationId);
      }
    }
  }
});
