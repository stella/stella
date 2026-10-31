import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import { contacts } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

import createContact from "./create";
import type { CreateContactBody } from "./create";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("contact create replay (postgres)", () => {
  test("an identical retry replays the original contact", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();

      try {
        await db.insert(user).values({
          id: userId,
          name: "Contact creator",
          email: `${userId}@contacts.test`,
        });
        await db.insert(organization).values({
          id: organizationId,
          name: "Contact replay",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });

        const body = {
          type: "person",
          displayName: "Ada Replay",
        } satisfies CreateContactBody;
        const key = "contact-create-lost-response";
        const scopedDb = createScopedDb(
          markRlsDatabase(db),
          [],
          organizationId,
          userId,
        );
        const invoke = async () =>
          await createContact.handler(
            createTestHandlerContext<
              Parameters<typeof createContact.handler>[0]
            >({
              scopedDb,
              safeDb: safeDbFromScoped(scopedDb),
              audit: auditRecorderDouble(),
              memberRole: sessionMemberRole("owner"),
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              body,
              params: {},
              query: {},
              route: "/contacts",
              set: { headers: {} },
              request: new Request("https://example.test/contacts", {
                method: "PUT",
                headers: { "Idempotency-Key": key },
              }),
            }),
          );

        const first = await invoke();
        expect(first).toMatchObject({ displayName: body.displayName });
        if (first instanceof Response || !("id" in first)) {
          panic("Initial contact create did not return a contact");
        }

        const replay = await invoke();
        expect(replay).toBeInstanceOf(Response);
        if (!(replay instanceof Response)) {
          panic("Contact retry did not return a replay response");
        }
        expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
        const replayBody: unknown = await replay.json();
        expect(replayBody).toMatchObject({ id: first.id });

        const rows = await db
          .select({ total: count() })
          .from(contacts)
          .where(eq(contacts.organizationId, organizationId));
        expect(rows.at(0)?.total).toBe(1);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
});
