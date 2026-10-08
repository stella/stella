import { panic } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { roles } from "@stll/permissions";
import { SANCTIONS_SOURCES } from "@stll/sanctions";
import type { SanctionsEntry } from "@stll/sanctions";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import { member } from "@/api/db/auth-schema";
import { rlsDb } from "@/api/db/root";
import {
  auditLogs,
  contacts,
  organizationSettings,
  sanctionsContactMarks,
  sanctionsOrganizationMarks,
  sanctionsSources,
  sanctionsEditions,
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
  sanctionsContactMatches,
  sanctionsContactScreenings,
  sanctionsScreeningEvents,
} from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { contactsRoute } from "@/api/handlers/contacts/routes";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { getAuth } from "@/api/lib/auth";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { drainSanctionsContactMarks } from "@/api/lib/lists/sanctions/monitoring-drain";
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
      payload: response.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.json()
        : await response.text(),
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
  expect(roleNames.toSorted().join(",")).toBe(
    Object.keys(roles).toSorted().join(","),
  );
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

const contactState = async (contactId: typeof contacts.$inferSelect.id) => ({
  contacts: await db.select().from(contacts).where(eq(contacts.id, contactId)),
  screenings: await db
    .select()
    .from(sanctionsContactScreenings)
    .where(eq(sanctionsContactScreenings.contactId, contactId))
    .orderBy(sanctionsContactScreenings.sourceId),
  matches: await db
    .select()
    .from(sanctionsContactMatches)
    .where(eq(sanctionsContactMatches.contactId, contactId))
    .orderBy(
      sanctionsContactMatches.sourceId,
      sanctionsContactMatches.sourceEntryId,
    ),
  events: await db
    .select()
    .from(sanctionsScreeningEvents)
    .where(eq(sanctionsScreeningEvents.contactId, contactId))
    .orderBy(sanctionsScreeningEvents.createdAt, sanctionsScreeningEvents.id),
  marks: await db
    .select()
    .from(sanctionsContactMarks)
    .where(eq(sanctionsContactMarks.contactId, contactId)),
  audits: await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.resourceId, contactId))
    .orderBy(auditLogs.createdAt, auditLogs.id),
});

const seedActiveEdition = async () => {
  const editionId = createSafeId<"sanctionsEdition">();
  const hash = hashSha256Hex(editionId);
  const payload = {
    source: "eu",
    issuer: SANCTIONS_SOURCES.eu.issuer,
    sourceId: "dispatch-hit",
    referenceNumber: null,
    entityType: "person",
    names: [{ name: "Synthetic Dispatch Person", quality: "strong" }],
    birthDates: [],
    nationalities: [],
    identifiers: [],
    addresses: [],
    programme: null,
    legalBasis: null,
    listedOn: null,
    sourceUrl: "https://example.test/dispatch-hit",
  } satisfies SanctionsEntry;
  await db.insert(sanctionsEditions).values({
    id: editionId,
    sourceId: "eu",
    markerKey: hash,
    contentHash: hash,
    publishedAt: "2026-10-02",
    state: "ready",
    entryCount: 1,
  });
  await db
    .insert(sanctionsEntryPayloads)
    .values({ contentHash: hash, payload });
  await db
    .insert(sanctionsEditionEntries)
    .values({ editionId, sourceEntryId: payload.sourceId, contentHash: hash });
  await db
    .update(sanctionsSources)
    .set({ activeEditionId: editionId, lastSuccessfulVerifiedAt: new Date() })
    .where(eq(sanctionsSources.id, "eu"));
};

const readHttp = async (browser: HumanBrowser, path: string) => {
  const response = await contactsRoute.handle(
    new Request(`http://localhost${path}`, {
      headers: { cookie: browser.cookieHeader() },
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const payload: unknown = await response.json();
  return payload;
};

test("contact monitoring endpoint and capability perform the requested transition", async () => {
  for (const transport of transports) {
    await seedActiveEdition();
    const { browser, organizationId } = await caller("member");
    const contact =
      (
        await db
          .insert(contacts)
          .values({
            organizationId,
            type: "person",
            displayName: "Synthetic Dispatch Person",
          })
          .returning()
      ).at(0) ?? panic("Contact fixture missing");
    const scopedDb = createMembershipScopedDb(rlsDb, {
      organizationId,
      userId: toSafeId<"user">(browser.userId),
      serverValidatedWorkspaceIds: [],
    });
    const drain = async () =>
      await drainSanctionsContactMarks({
        db: scopedDb,
        organizationId,
        now: new Date(),
        signal: new AbortController().signal,
      });
    expect((await drain()).unwrap()).toEqual({
      claimed: 1,
      terminal: 1,
      hasMore: false,
    });
    const before = await contactState(contact.id);
    expect(before.matches).toHaveLength(1);
    expect(before.matches.at(0)?.state).toBe("active");
    expect(before.events).toHaveLength(1);
    expect(before.marks).toHaveLength(0);
    expect(
      await readHttp(browser, "/contacts/sanctions/matches"),
    ).toMatchObject({ items: [{ contactId: contact.id }] });
    const excluded = await dispatch({
      transport,
      browser,
      capability: "contacts.sanctions.monitoring.update",
      contactId: contact.id,
      mode: "excluded",
    });
    expect(excluded.ok, JSON.stringify(excluded.payload)).toBe(true);
    expect(excluded.payload).toMatchObject(
      transport === "http"
        ? { mode: "excluded" }
        : { result: { mode: "excluded" } },
    );
    const after = await contactState(contact.id);
    expect(after.contacts).toHaveLength(1);
    expect(after.contacts.at(0)?.sanctionsMonitoringMode).toBe("excluded");
    expect(after.screenings.map((row) => row.sourceId).toSorted()).toEqual(
      sanctionsSourceIds().toSorted(),
    );
    expect(after.screenings).toHaveLength(sanctionsSourceIds().length);
    expect(
      after.screenings.every(
        (row) =>
          row.status === "excluded" &&
          row.editionId === null &&
          row.reason === "contact-excluded",
      ),
    ).toBe(true);
    expect(after.matches).toHaveLength(1);
    expect(after.matches.at(0)).toMatchObject({
      state: "lapsed",
      match: before.matches.at(0)?.match,
      sourceEntryId: "dispatch-hit",
    });
    expect(after.events).toEqual(before.events);
    expect(after.marks).toHaveLength(1);
    expect(after.audits).toHaveLength(1);
    expect(after.audits.at(0)).toMatchObject({
      userId: browser.userId,
      organizationId,
      workspaceId: null,
      resourceId: contact.id,
      changes: {
        sanctionsMonitoringMode: { old: "included", new: "excluded" },
      },
    });
    expect(
      await readHttp(browser, `/contacts/${contact.id}/sanctions`),
    ).toMatchObject({ contactMode: "excluded", matches: { items: [] } });
    expect(
      await readHttp(browser, "/contacts/sanctions/matches"),
    ).toMatchObject({ items: [] });
    expect(await readHttp(browser, "/contacts/sanctions/events")).toMatchObject(
      { items: [] },
    );
    const replay = await dispatch({
      transport,
      browser,
      capability: "contacts.sanctions.monitoring.update",
      contactId: contact.id,
      mode: "excluded",
    });
    expect(replay.ok).toBe(true);
    expect((await contactState(contact.id)).audits).toEqual(after.audits);
    expect((await contactState(contact.id)).events).toEqual(before.events);
    const included = await dispatch({
      transport,
      browser,
      capability: "contacts.sanctions.monitoring.update",
      contactId: contact.id,
      mode: "included",
    });
    expect(included.ok, JSON.stringify(included.payload)).toBe(true);
    expect(included.payload).toMatchObject(
      transport === "http"
        ? { mode: "included" }
        : { result: { mode: "included" } },
    );
    const queued = await contactState(contact.id);
    expect(queued.contacts.at(0)?.sanctionsMonitoringMode).toBe("included");
    expect(queued.marks).toHaveLength(1);
    expect(queued.marks.at(0)?.contactId).toBe(contact.id);
    expect(queued.audits).toHaveLength(2);
    expect(queued.audits.at(-1)).toMatchObject({
      userId: browser.userId,
      changes: {
        sanctionsMonitoringMode: { old: "excluded", new: "included" },
      },
    });
    const includedReplay = await dispatch({
      transport,
      browser,
      capability: "contacts.sanctions.monitoring.update",
      contactId: contact.id,
      mode: "included",
    });
    expect(includedReplay.ok).toBe(true);
    expect((await contactState(contact.id)).audits).toEqual(queued.audits);
    expect((await contactState(contact.id)).marks).toEqual(queued.marks);
    expect((await drain()).unwrap()).toEqual({
      claimed: 1,
      terminal: 1,
      hasMore: false,
    });
    const refreshed = await contactState(contact.id);
    expect(refreshed.marks).toHaveLength(0);
    expect(refreshed.matches).toHaveLength(1);
    expect(refreshed.matches.at(0)?.state).toBe("active");
    expect(refreshed.events).toHaveLength(2);
    expect(refreshed.events.at(-1)?.type).toBe("reopened");
    expect(
      await readHttp(browser, "/contacts/sanctions/matches"),
    ).toMatchObject({ items: [{ contactId: contact.id }] });

    const stable = await contactState(contact.id);
    const outsider = await caller("external");
    const foreign = await dispatch({
      transport,
      browser: outsider.browser,
      capability: "contacts.sanctions.monitoring.update",
      contactId: contact.id,
      mode: "excluded",
    });
    expect(foreign.ok).toBe(false);
    if (transport === "http") {
      expect(foreign.status).toBe(403);
    } else {
      expect(foreign.payload).toMatchObject({
        error: { code: "permission_denied" },
      });
    }
    const foreignMember = await caller("member");
    const wrongOrganization = await dispatch({
      transport,
      browser: foreignMember.browser,
      capability: "contacts.sanctions.monitoring.update",
      contactId: contact.id,
      mode: "excluded",
    });
    expect(wrongOrganization.ok).toBe(false);
    if (transport === "http") {
      expect(wrongOrganization.status).toBe(404);
    } else {
      expect(wrongOrganization.payload).toMatchObject({
        error: { code: "not_found" },
      });
    }
    const invalid = await dispatch({
      transport,
      browser,
      capability: "contacts.sanctions.monitoring.update",
      contactId: contact.id,
      mode: "unsupported",
    });
    expect(invalid.ok).toBe(false);
    if (transport === "http") {
      expect(invalid.status).toBe(422);
    } else {
      expect(invalid.payload).toMatchObject({
        error: { code: "validation_error" },
      });
    }
    expect(await contactState(contact.id)).toEqual(stable);
  }
});
