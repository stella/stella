import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { MATTER_VISIBILITY } from "@stll/api-contract";
import { CHAT_THREAD_SCOPE_MISMATCH_CODE } from "@stll/api-contract/chat-thread-scope";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  chatThreads,
  contacts,
  featureEnrolments,
  workspaceContacts,
  workspaces,
} from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import getMessages from "@/api/handlers/chat/messages/list";
import { clientInvoicesRoute } from "@/api/handlers/client-invoices/routes";
import { resolveClientInvoiceMatters } from "@/api/handlers/client-invoices/selection";
import { contactsRoute } from "@/api/handlers/contacts/routes";
import { createDesktopMatterCandidatesEndpoint } from "@/api/handlers/desktop-time-entries/candidates";
import { createDesktopMattersEndpoint } from "@/api/handlers/desktop-time-entries/matters";
import { searchRoute } from "@/api/handlers/search/routes";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import { mount, routes } from "@/api/http/route";
import { getAuth } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { readAuthorizedWorkspaces } from "@/api/lib/workspaces/authorized-workspace-ids";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { signInHuman } from "@/api/tests/helpers/human-session";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";

const testState = createTestState({ file: import.meta.path, config: env });

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const matterReads = workspacesRoute.filter(
  (entry) => entry.definition.access === "workspace",
);

describe.skipIf(!enabled)("matter visibility reads (postgres)", () => {
  test("every mounted matter read refuses an unassigned member, while discovery omits hidden matters", async () => {
    await withGatedTestClients(
      process.env["DATABASE_URL"] ?? panic("Missing test database"),
      async ({ openClient }) => {
        const { db } = openClient();
        testState.setConfig("FEATURE_TIME_BILLING", true);

        const owner = await signInHuman(
          `visibility-owner-${Bun.randomUUIDv7()}@stella.dev`,
        );
        const viewer = await signInHuman(
          `visibility-viewer-${Bun.randomUUIDv7()}@stella.dev`,
        );
        const auth = getAuth();
        const org = await auth.api.createOrganization({
          body: {
            name: "Visibility reads",
            slug: `visibility-${Bun.randomUUIDv7()}`,
          },
          headers: owner.headers(),
        });
        const organizationId = brandPersistedOrganizationId(org.id);
        testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
          "time-billing": [{ type: "organization", organizationId }],
          "activity-timeline": [{ type: "organization", organizationId }],
        });
        await owner.setActiveOrganization(org.id);
        const invitation = await auth.api.createInvitation({
          body: { email: viewer.email, role: "member", organizationId: org.id },
          headers: owner.headers(),
        });
        await auth.api.acceptInvitation({
          body: { invitationId: invitation.id },
          headers: viewer.headers(),
        });
        await viewer.setActiveOrganization(org.id);
        const workspaceId = createSafeId<"workspace">();
        const clientId = createSafeId<"contact">();
        const scopedDb = createMembershipScopedDb(markRlsDatabase(db), {
          organizationId,
          userId: brandPersistedUserId(viewer.userId),
          serverValidatedWorkspaceIds: [],
        });
        const device = await createDesktopDeviceSigner();
        const authorizeDesktop = async (request: Request) =>
          Result.ok({
            organizationId,
            userId: brandPersistedUserId(viewer.userId),
            scopedDb,
            keyId: "desktop-key",
            memberRole: sessionMemberRole("member"),
            consumedProof: await claimFixtureDeviceProof({
              request: await device.signRequest({
                request,
                credential: "fixture-credential",
              }),
              deviceJkt: device.deviceJkt,
              keyId: "desktop-key",
              credential: "fixture-credential",
            }),
          });
        const desktopReads = routes({
          "/threads/:threadId/messages": { GET: getMessages },
          "/desktop/matters": {
            GET: createDesktopMattersEndpoint(authorizeDesktop),
          },
          "/desktop/matter-candidates": {
            GET: createDesktopMatterCandidatesEndpoint(authorizeDesktop),
          },
        });
        await using server = serveRoutesForTest(
          mount(
            [
              workspacesRoute,
              contactsRoute,
              clientInvoicesRoute,
              searchRoute,
              desktopReads,
            ],
            { prefix: "/v1" },
          ),
        );
        const read = async (path: string, browser = viewer) =>
          await server.fetch(`http://localhost/v1${path}`, {
            headers: browser.headers(),
            signal: AbortSignal.timeout(10_000),
          });
        try {
          await db.insert(featureEnrolments).values({
            organizationId,
            userId: viewer.userId,
            featureId: "time-billing",
          });
          await db.insert(contacts).values({
            id: clientId,
            organizationId,
            type: "person",
            displayName: "Novák",
          });
          await db.insert(workspaces).values({
            clientId,
            id: workspaceId,
            organizationId,
            visibility: MATTER_VISIBILITY.adminsAndAssigned,
            name: "Řízení Novák",
            reference: workspaceId,
          });
          const threadId = createSafeId<"chatThread">();
          await db.insert(chatThreads).values({
            id: threadId,
            workspaceId,
            organizationId,
            userId: viewer.userId,
            title: "Matter discussion",
          });
          const hiddenThread = await read(`/threads/${threadId}/messages`);
          expect(hiddenThread.status).toBe(404);
          expect(await hiddenThread.json()).toEqual({
            message: "Chat thread not found",
          });
          await db
            .update(member)
            .set({ lastActiveWorkspaceId: workspaceId })
            .where(
              and(
                eq(member.organizationId, organizationId),
                eq(member.userId, viewer.userId),
              ),
            );
          await db.insert(workspaceContacts).values({
            id: createSafeId<"workspaceContact">(),
            organizationId,
            workspaceId,
            contactId: clientId,
            role: "client",
          });
          const privateId = createSafeId<"workspace">();
          const ownerDb = createMembershipScopedDb(markRlsDatabase(db), {
            organizationId,
            userId: brandPersistedUserId(owner.userId),
            serverValidatedWorkspaceIds: [],
          });
          await ownerDb(
            async (tx) =>
              await tx.execute(
                sql`SELECT public.stella_create_workspace(${privateId}::uuid, NULL, 'Soukromé řízení', ${privateId}, NULL, NULL, NULL)`,
              ),
          );
          expect(
            await db.query.workspaces.findFirst({
              where: { id: { eq: privateId } },
              columns: { visibility: true, leadUserId: true },
            }),
          ).toEqual({
            visibility: MATTER_VISIBILITY.assignedOnly,
            leadUserId: owner.userId,
          });
          const control = await read(`/workspaces/${workspaceId}`, owner);
          expect(control.status).toBe(200);
          expect(await control.json()).toMatchObject({ id: workspaceId });
          expect(matterReads.length).toBeGreaterThan(15);
          expect(
            workspacesRoute
              .filter(
                (entry) =>
                  entry.method === "GET" &&
                  entry.definition.access === "member",
              )
              .map((entry) => entry.path)
              .toSorted(),
          ).toEqual([
            "/workspaces",
            "/workspaces/active",
            "/workspaces/member-previews",
            "/workspaces/navigation",
          ]);
          for (const entry of matterReads) {
            const path = entry.path
              .replace(":workspaceId", () => workspaceId)
              .replace(/:[A-Za-z]+/gu, () => createSafeId<"entity">());
            const response = await server.fetch(`http://localhost/v1${path}`, {
              method: entry.method,
              headers: viewer.headers(),
              signal: AbortSignal.timeout(10_000),
            });
            expect({ path: entry.path, status: response.status }).toEqual({
              path: entry.path,
              status: 404,
            });
          }
          const list = await read("/workspaces");
          expect(list.status).toBe(200);
          expect(await list.json()).toMatchObject({ workspaces: [] });
          const navigation = await read("/workspaces/navigation");
          expect(navigation.status).toBe(200);
          expect(await navigation.json()).toMatchObject({ workspaces: [] });
          const previews = await read(
            `/workspaces/member-previews?workspaceIds=${workspaceId}`,
          );
          expect(previews.status).toBe(200);
          expect(await previews.json()).toEqual({ previews: [] });
          const active = await read("/workspaces/active");
          expect(active.status).toBe(200);
          expect(await active.json()).toEqual({ lastActiveWorkspaceId: null });
          const contact = await read(`/contacts/${clientId}`);
          expect(contact.status).toBe(200);
          expect(await contact.json()).toMatchObject({
            clientMatterCount: 0,
            clientMatters: [],
            partyMatters: [],
            partyCount: 0,
          });
          const invoice = await read(`/client-invoices/${clientId}/prefill`);
          expect(invoice.status).toBe(200);
          expect(await invoice.json()).toMatchObject({ matters: [] });
          const selected = await scopedDb(
            async (tx) =>
              await resolveClientInvoiceMatters(tx, {
                organizationId,
                clientId,
                workspaceIds: [workspaceId],
              }),
          );
          expect(selected.isErr()).toBe(true);
          if (selected.isOk()) {
            panic("Hidden matter was selected");
          }
          expect(selected.error.status).toBe(404);
          const authorized = await scopedDb(
            async (tx) =>
              await readAuthorizedWorkspaces(tx, { organizationId }),
          );
          if (authorized.isErr()) {
            panic("Authorization read failed");
          }
          expect(authorized.value.workspaces).toEqual([]);
          const context = authorizedMcpContextForTest({
            accessibleWorkspaceIds: [],
            accessibleWorkspaceIdSet: new Set<string>(),
            accessibleWorkspaceStatusById: new Map(),
            accessibleWorkspaces: authorized.value.workspaces,
            grantedScopes: [],
            memberRole: "member",
            organizationId,
            scopedDb,
            safeDb: safeDbFromScoped(scopedDb),
            userId: brandPersistedUserId(viewer.userId),
            userEmail: viewer.email,
            recordAuditEvent: async () => undefined,
          });
          const listed = await handleMcpToolCall({
            toolName: "list_matters",
            args: {},
            context,
          });
          expect(listed.isError).not.toBe(true);
          expect(listed.structuredContent).toMatchObject({ matters: [] });
          const detail = await handleMcpToolCall({
            toolName: "list_matters",
            args: { matter_id: workspaceId },
            context,
          });
          expect(detail.isError).toBe(true);
          const search = await server.fetch("http://localhost/v1/search", {
            method: "POST",
            headers: {
              ...Object.fromEntries(viewer.headers()),
              "content-type": "application/json",
            },
            body: JSON.stringify({
              query: "Novák",
              workspaceIds: [workspaceId],
              types: ["matter"],
              kinds: [],
              editedByUserIds: [],
              mimeTypes: [],
            }),
            signal: AbortSignal.timeout(10_000),
          });
          expect(search.status).toBe(400);
          expect(await search.json()).toEqual({
            message: "Workspace not found in organization",
          });
          const preview = await server.fetch(
            "http://localhost/v1/search/preview",
            {
              method: "POST",
              headers: {
                ...Object.fromEntries(viewer.headers()),
                "content-type": "application/json",
              },
              body: JSON.stringify({
                query: "Novák",
                resultId: workspaceId,
                type: "matter",
              }),
              signal: AbortSignal.timeout(10_000),
            },
          );
          expect(preview.status).toBe(404);
          for (const path of [
            "/desktop/matters",
            "/desktop/matter-candidates",
          ]) {
            const desktop = await read(path);
            expect({ path, status: desktop.status }).toEqual({
              path,
              status: 200,
            });
            expect(await desktop.json()).toMatchObject({ matters: [] });
          }

          await db
            .update(workspaces)
            .set({ visibility: MATTER_VISIBILITY.allMembers })
            .where(eq(workspaces.id, workspaceId));
          const opened = await read(`/workspaces/${workspaceId}`);
          expect(opened.status).toBe(200);
          expect(await opened.json()).toMatchObject({
            id: workspaceId,
            visibility: MATTER_VISIBILITY.allMembers,
          });
          const readableThread = await read(`/threads/${threadId}/messages`);
          expect(readableThread.status).toBe(400);
          expect(await readableThread.json()).toMatchObject({
            code: CHAT_THREAD_SCOPE_MISMATCH_CODE,
            workspaceId,
          });
          const remembered = await read("/workspaces/active");
          expect(await remembered.json()).toEqual({
            lastActiveWorkspaceId: workspaceId,
          });
          const definitions = v.parse(
            v.array(
              v.object({ proname: v.string(), proconfig: v.array(v.string()) }),
            ),
            executedRows(
              await db.execute(
                sql`SELECT proname, proconfig FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef AND proname IN ('stella_authorized_workspace_ids', 'stella_create_workspace', 'stella_lock_matter_stewardship', 'enforce_member_role_keeps_matter_leads', 'enforce_workspace_keeps_matter_lead', 'enforce_inserted_workspace_keeps_matter_lead', 'enforce_assignment_keeps_matter_lead')`,
              ),
            ),
          );
          expect(definitions).toHaveLength(8);
          for (const definition of definitions) {
            expect(definition["proconfig"]).toContain(
              "search_path=pg_catalog, public, pg_temp",
            );
          }
          const authorizationFunctions = definitions.filter(
            (definition) =>
              definition.proname === "stella_authorized_workspace_ids",
          );
          expect(authorizationFunctions).toHaveLength(1);
          expect(authorizationFunctions.at(0)?.proconfig).toContain(
            "plan_cache_mode=force_generic_plan",
          );
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, owner.userId));
          await db.delete(user).where(eq(user.id, viewer.userId));
        }
      },
    );
  });
});
