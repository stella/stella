import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  correspondence,
  correspondenceAllowedSenders,
  matterInboundAddresses,
  workspaces,
} from "@/api/db/schema";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { createCorrespondence } from "@/api/lib/correspondence/create";
import { generateInboundAddressToken } from "@/api/lib/inbound-mail/address";
import type { MailAuthentication } from "@/api/lib/inbound-mail/authentication";
import type { PersistInboundDeliveryOptions } from "@/api/lib/inbound-mail/ingest";
import {
  createInboundMailStore,
  type FileInboundCandidateOptions,
} from "@/api/lib/inbound-mail/store";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("shared mailbox filing locks (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("shared mailbox filing locks (postgres)", () => {
    test("two deliveries into distinct matters both file while one approval is contested", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: setupDb } = openClient();
        const { db: firstDb } = openClient();
        const { db: secondDb } = openClient();
        const { db: observerDb } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const adminId = mintAuthProviderId<"user">();
        const firstWorkspaceId = createSafeId<"workspace">();
        const secondWorkspaceId = createSafeId<"workspace">();
        const allowedSenderId = createSafeId<"correspondenceAllowedSender">();
        const firstToken = generateInboundAddressToken();
        const secondToken = generateInboundAddressToken();
        const sender = "office@example.test";
        const receivedAt = "2026-09-26T12:00:00.000Z";
        const firstAtCandidate = Promise.withResolvers<undefined>();
        const secondAtCandidate = Promise.withResolvers<undefined>();
        const secondTransactionStarted = Promise.withResolvers<number>();
        const releaseCandidates = Promise.withResolvers<undefined>();
        const activeDeliveries: Promise<unknown>[] = [];

        const authentication = {
          source: "provider",
          evidence: "identifiers",
          fromDomain: "example.test",
          spf: {
            result: "pass",
            domain: "example.test",
            alignment: "strict",
          },
          dkim: [],
          dmarc: "pass",
        } as const satisfies MailAuthentication;
        const delivery = {
          status: "candidate",
          sender,
          authentication,
          attachments: [],
          message: {
            direction: "out",
            channel: "email",
            messageId: `<${Bun.randomUUIDv7()}@example.test>`,
            contentHash: "a".repeat(64),
            from: { address: sender, name: null },
            to: [{ address: "matter@example.test", name: null }],
            cc: [],
            subject: "Shared mailbox delivery",
            sentAt: receivedAt,
            receivedAt,
            inReplyTo: null,
            references: [],
            bodyText: "A filed message",
            bodyHtml: null,
            intake: "direct",
            originalSignature: null,
            authenticatedSender: {
              address: sender,
              spf: "pass",
              dkim: "none",
              dmarc: "pass",
              alignedIdentifier: "example.test",
            },
          },
        } satisfies Extract<
          PersistInboundDeliveryOptions["delivery"],
          { status: "candidate" }
        >;

        try {
          await setupDb.insert(user).values({
            id: adminId,
            name: "Mailbox approver",
            email: `approver-${Bun.randomUUIDv7()}@example.test`,
            emailVerified: true,
          });
          await setupDb.insert(organization).values({
            id: organizationId,
            name: "Concurrent mailbox filing",
            slug: `mailbox-lock-${Bun.randomUUIDv7()}`,
            createdAt: new Date(),
          });
          await setupDb.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId: adminId,
            role: "owner",
            createdAt: new Date(),
          });
          await setupDb.insert(workspaces).values([
            {
              id: firstWorkspaceId,
              organizationId,
              name: "First matter",
              reference: "LOCK-1",
            },
            {
              id: secondWorkspaceId,
              organizationId,
              name: "Second matter",
              reference: "LOCK-2",
            },
          ]);
          await setupDb.insert(matterInboundAddresses).values([
            {
              organizationId,
              workspaceId: firstWorkspaceId,
              token: firstToken,
            },
            {
              organizationId,
              workspaceId: secondWorkspaceId,
              token: secondToken,
            },
          ]);
          await setupDb.insert(correspondenceAllowedSenders).values({
            id: allowedSenderId,
            organizationId,
            address: sender,
            kind: "shared_mailbox",
            scope: "organization",
            approvedBy: adminId,
          });

          const fileCandidate = async ({
            tx,
            workspaceId,
            filer,
            delivery: candidate,
          }: FileInboundCandidateOptions<Transaction>) => {
            const result = await createCorrespondence({
              safeDb: async (work) => await Result.tryPromise(() => work(tx)),
              organizationId,
              workspaceId,
              filer,
              parsed: candidate.message,
              attachments: [],
              recordAuditEvent: createBackgroundAuditRecorder({
                organizationId,
                workspaceId,
                userId: `mailbox:${allowedSenderId}`,
                execution: {
                  performer: {
                    type: "service",
                    id: `mailbox:${allowedSenderId}`,
                    name: null,
                  },
                  trigger: { type: "webhook", source: "inbound_mail" },
                },
              }),
            });
            if (result.type === "error") {
              throw result.error;
            }
            if (result.type !== "ok") {
              throw new Error(`Filing failed: ${result.type}`);
            }
            return {
              status: result.created
                ? ("filed" as const)
                : ("duplicate" as const),
              correspondenceId: result.id,
            };
          };

          const firstStore = createInboundMailStore({
            database: {
              transaction: async (work) =>
                await firstDb.transaction(async (tx) => {
                  await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
                  return await work(tx);
                }),
            },
            fileCandidate: async (candidate) => {
              firstAtCandidate.resolve(undefined);
              await releaseCandidates.promise;
              return await fileCandidate(candidate);
            },
          });
          const secondStore = createInboundMailStore({
            database: {
              transaction: async (work) =>
                await secondDb.transaction(async (tx) => {
                  await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
                  const [session] = await tx.execute<{ pid: number }>(
                    sql`SELECT pg_backend_pid() AS pid`,
                  );
                  if (!session) {
                    throw new Error("Second database session is unavailable");
                  }
                  secondTransactionStarted.resolve(session.pid);
                  return await work(tx);
                }),
            },
            fileCandidate: async (candidate) => {
              secondAtCandidate.resolve(undefined);
              await releaseCandidates.promise;
              return await fileCandidate(candidate);
            },
          });

          const first = firstStore({
            token: firstToken,
            deliveryKey: Bun.randomUUIDv7(),
            receivedAt,
            delivery,
          });
          activeDeliveries.push(first);
          await firstAtCandidate.promise;
          const second = secondStore({
            token: secondToken,
            deliveryKey: Bun.randomUUIDv7(),
            receivedAt,
            delivery,
          });
          activeDeliveries.push(second);
          const secondPid = await secondTransactionStarted.promise;
          let secondBlocked = false;
          let secondReachedCandidate = false;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const [wait] = await observerDb.execute<{ blocked: boolean }>(sql`
              SELECT cardinality(pg_blocking_pids(${secondPid})) > 0 AS blocked
            `);
            secondBlocked = wait?.blocked ?? false;
            secondReachedCandidate = await Promise.race([
              secondAtCandidate.promise.then(() => true),
              Bun.sleep(20).then(() => false),
            ]);
            if (secondBlocked || secondReachedCandidate) {
              break;
            }
          }
          expect(secondBlocked || secondReachedCandidate).toBe(true);
          releaseCandidates.resolve(undefined);
          const outcomes = await Promise.allSettled([first, second]);
          expect(
            outcomes.map((outcome) =>
              outcome.status === "rejected"
                ? getPgErrorCode(outcome.reason)
                : null,
            ),
          ).toEqual([null, null]);
          expect(outcomes).toMatchObject([
            { status: "fulfilled", value: { status: "filed" } },
            { status: "fulfilled", value: { status: "filed" } },
          ]);
          const rows = await setupDb
            .select({ workspaceId: correspondence.workspaceId })
            .from(correspondence)
            .where(eq(correspondence.organizationId, organizationId));
          expect(rows.map(({ workspaceId }) => workspaceId).toSorted()).toEqual(
            [firstWorkspaceId, secondWorkspaceId].toSorted(),
          );
        } finally {
          releaseCandidates.resolve(undefined);
          await Promise.allSettled(activeDeliveries);
          await setupDb
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await setupDb.delete(user).where(eq(user.id, adminId));
        }
      });
    }, 20_000);
  });
}
