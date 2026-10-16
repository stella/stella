import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { OutboundActionPreview } from "@stll/api-contract/outbound-action";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { chatThreads, outboundActions } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { outboundPreviewHash } from "@/api/lib/outbound-actions/preview";
import { prepareOutboundAction } from "@/api/lib/outbound-actions/store";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createConfirmOutboundActionHandler } from "./confirm";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const preview = {
  kind: "email.send",
  from: { address: "sender@example.test" },
  to: [{ address: "recipient@example.test" }],
  cc: [],
  bcc: [],
  subject: "Smlouva o dílo",
  bodyText: "Prosím o kontrolu přiložené smlouvy.",
  attachments: [],
  inReplyTo: null,
} satisfies OutboundActionPreview;
const previewHash = outboundPreviewHash(preview);
const noAudit: AuditRecorder = async () => undefined;

const observeBlocking = async (
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "select">,
  pid: number,
) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await tx
      .select({
        blocked: sql<boolean>`pg_backend_pid() = ANY(pg_blocking_pids(${pid}))`,
      })
      .from(sql`(SELECT 1) AS lock_observation`);
    if (rows.at(0)?.blocked) {
      return;
    }
    await Bun.sleep(10);
  }
  panic("The second confirm did not reach the claimed row");
};

if (!databaseUrl || !runPostgres) {
  describe.skip("outbound action confirm claim (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  test("a confirm racing an uncommitted claim sends nothing and gets a conflict", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: firstDb } = openClient({ max: 1 });
      const { db: secondDb } = openClient({ max: 1 });
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const chatThreadId = createSafeId<"chatThread">();
      try {
        await firstDb.insert(user).values({
          id: userId,
          name: "Outbound test member",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await firstDb.insert(organization).values({
          id: organizationId,
          name: "Outbound test organization",
          slug: organizationId,
          createdAt: new Date(),
        });
        await firstDb.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });
        await firstDb.insert(chatThreads).values({
          id: chatThreadId,
          organizationId,
          title: "Odeslání smlouvy",
          userId,
          workspaceId: null,
        });
        const prepared = await firstDb.transaction(
          async (tx) =>
            await prepareOutboundAction({
              tx: asTestRaw<Transaction>(tx),
              organizationId,
              userId,
              chatThreadId,
              preview,
              now: new Date(),
              recordAuditEvent: noAudit,
            }),
        );
        const actionId = prepared.unwrap().id;
        const pidRows = await secondDb
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(sql`(SELECT 1) AS backend_identity`);
        const secondPid =
          pidRows.at(0)?.pid ?? panic("Second backend identity missing");

        const sent: string[] = [];
        const confirm = createConfirmOutboundActionHandler({
          "email.send": async () => {
            sent.push(actionId);
            return Result.ok({ providerMessageId: "message-1" });
          },
        });
        type ConfirmContext = Parameters<typeof confirm.handler>[0];
        const run = async (
          db: typeof firstDb,
          recordAuditEvent: AuditRecorder,
        ) =>
          await confirm.handler(
            createTestHandlerContext<ConfirmContext>({
              scopedDb: NO_DB,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb: createSafeDb(
                markRlsDatabase(db),
                [],
                organizationId,
                userId,
              ),
              audit: recordAuditEvent,
              params: { actionId },
              body: { previewHash },
            }),
          );

        // The first confirm pauses inside its transaction right after its
        // claim, holding the row, until the second confirm blocks on that
        // row. The second has already read the committed `pending` row, so it
        // must lose at its own claim, not at an earlier check.
        const claimed = Promise.withResolvers<undefined>();
        const secondStarted = Promise.withResolvers<undefined>();
        let gated = false;
        // Only the claim's audit is gated; the outcome audit after the send
        // passes straight through.
        const gatedAudit: AuditRecorder = async (tx) => {
          if (gated) {
            return;
          }
          gated = true;
          claimed.resolve(undefined);
          await secondStarted.promise;
          await observeBlocking(tx, secondPid);
        };
        const tasks: Promise<unknown>[] = [];
        try {
          const first = Result.tryPromise(
            async () => await run(firstDb, gatedAudit),
          );
          tasks.push(first);
          await Promise.race([
            claimed.promise,
            first.then(() =>
              panic("The first confirm never reached its claim"),
            ),
          ]);
          const second = Result.tryPromise(
            async () => await run(secondDb, noAudit),
          );
          tasks.push(second);
          secondStarted.resolve(undefined);
          const [firstResult, secondResult] = await Promise.all([
            first,
            second,
          ]);
          expect(firstResult.unwrap()).toMatchObject({ status: "sent" });
          expect(secondResult.unwrap()).toMatchObject({ code: 409 });
        } finally {
          claimed.resolve(undefined);
          secondStarted.resolve(undefined);
          await Promise.allSettled(tasks);
        }

        expect(sent).toEqual([actionId]);
        const rows = await firstDb
          .select({ status: outboundActions.status })
          .from(outboundActions)
          .where(eq(outboundActions.id, actionId));
        expect(rows).toEqual([{ status: "sent" }]);
      } finally {
        await firstDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await firstDb.delete(user).where(eq(user.id, userId));
      }
    });
  });
}
