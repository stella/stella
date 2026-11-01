import { describe, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";

import type { ParsedCorrespondence } from "@stll/api-contract/correspondence";
import type { DataBoxStatedEnvelope } from "@stll/api-contract/data-box";
import { waitForExternalState } from "@stll/property-testing/external-state";
import { sha256Hex } from "@stll/sha256/bun";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceSources,
  entities,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
import { prepareCorrespondenceContent } from "@/api/lib/email/correspondence/uploaded-content";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  type GatedTestClientScope,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type UploadedCorrespondence = Extract<
  ParsedCorrespondence,
  { source: "upload" }
>;

const envelope = (messageId: string): DataBoxStatedEnvelope => ({
  messageId,
  messageType: "V",
  sender: {
    boxId: "abc2def",
    name: "Okresní soud v Testově",
    address: null,
    referenceNumber: null,
    fileMark: null,
  },
  recipient: {
    boxId: "xyz9876",
    name: "Advokátní kancelář Příklad",
    address: null,
    referenceNumber: null,
    fileMark: null,
  },
  toHands: null,
  personalDelivery: null,
  substituteDelivery: null,
  deliveredAt: "2026-10-14T07:12:33.120Z",
  acceptedAt: null,
  status: "delivered",
  seal: {
    status: "unverified",
    signerName: null,
    issuerName: null,
    serialNumber: null,
    signedAt: null,
  },
});

/** One uploaded `.zfo` copy of a data-box message, keyed by its message ID. */
const dataBoxCopy = (
  sourceEntityId: SafeId<"entity">,
  messageId: string,
): UploadedCorrespondence => ({
  source: "upload",
  sourceEntityId,
  originalSignature: { status: "unverified" },
  channel: "data_box",
  dataBox: envelope(messageId),
  direction: null,
  messageId,
  contentHash: sha256Hex(messageId),
  from: { address: "abc2def", name: null },
  to: [{ address: "xyz9876", name: null }],
  cc: [],
  subject: `Message ${messageId}`,
  sentAt: null,
  receivedAt: "2026-10-14T07:12:33.120Z",
  inReplyTo: null,
  references: [],
  bodyText: "",
  bodyHtml: null,
});

describe("correspondence filing options", () => {
  test("an upload filing names the source version its job read", () => {
    type FilingOptions = Parameters<typeof createCorrespondence>[0];
    type UploadWithoutVersion = Omit<
      Extract<FilingOptions, { parsed: { source: "upload" } }>,
      "expectedSourceVersionId"
    >;
    // Typechecking fails here if an upload may omit its version again.
    const refusesUnversionedUpload: UploadWithoutVersion extends FilingOptions
      ? false
      : true = true;
    expect(refusesUnversionedUpload).toBe(true);
  });
});

type Fixture = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
};

const seedMatter = async (
  { openClient }: GatedTestClientScope,
  sourceCount: number,
) => {
  const { db: adminDb } = openClient({ max: 1 });
  const fixture: Fixture = {
    organizationId: mintAuthProviderId<"organization">(),
    workspaceId: createSafeId<"workspace">(),
    userId: mintAuthProviderId<"user">(),
  };
  const suffix = Bun.randomUUIDv7().replaceAll("-", "");
  await adminDb.insert(organization).values({
    id: fixture.organizationId,
    name: "Source race fixture",
    slug: `source-race-${suffix}`,
    createdAt: new Date(),
  });
  await recordNewOrganizationAccessState(adminDb, {
    organizationId: fixture.organizationId,
    now: new Date(),
  });
  await adminDb.insert(workspaces).values({
    id: fixture.workspaceId,
    organizationId: fixture.organizationId,
    name: "Source race matter",
    reference: suffix,
  });
  await adminDb.insert(user).values({
    id: fixture.userId,
    name: "Uploader",
    email: `source-race-${suffix}@example.test`,
  });
  await adminDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId: fixture.organizationId,
    userId: fixture.userId,
    role: "owner",
    createdAt: new Date(),
  });
  await adminDb.insert(workspaceMembers).values({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
  });
  const sources = Array.from({ length: sourceCount }, () =>
    createSafeId<"entity">(),
  );
  await adminDb.insert(entities).values(
    sources.map((id, index) => ({
      id,
      workspaceId: fixture.workspaceId,
      name: `copy-${String(index)}.zfo`,
      createdBy: fixture.userId,
    })),
  );
  const cleanUp = async () => {
    await adminDb
      .delete(organization)
      .where(eq(organization.id, fixture.organizationId));
    await adminDb.delete(user).where(eq(user.id, fixture.userId));
  };
  return { adminDb, fixture, sources, cleanUp };
};

type Writer = ReturnType<GatedTestClientScope["openClient"]>;

const fileCopy = async (
  writer: Writer,
  fixture: Fixture,
  sourceEntityId: SafeId<"entity">,
  messageId: string,
) =>
  await createCorrespondence({
    safeDb: createSafeDb(
      markRlsDatabase(writer.db),
      [fixture.workspaceId],
      fixture.organizationId,
      fixture.userId,
    ),
    workspaceId: fixture.workspaceId,
    organizationId: fixture.organizationId,
    filer: { type: "user", userId: fixture.userId },
    parsed: dataBoxCopy(sourceEntityId, messageId),
    expectedSourceVersionId: null,
    attachments: [],
    recordAuditEvent: createBackgroundAuditRecorder({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      userId: fixture.userId,
      execution: {
        performer: { type: "user", id: fixture.userId },
        trigger: { type: "system", source: "source_race_test" },
      },
    }),
  });

/**
 * Every record and its sources, read through the matter scope. A consistent
 * matter has no record without a source, and each record's current source
 * pointer names one of its own sources.
 */
const readSourceState = async (writer: Writer, fixture: Fixture) =>
  await createScopedDb(
    markRlsDatabase(writer.db),
    [fixture.workspaceId],
    fixture.organizationId,
    fixture.userId,
  )(async (tx) => {
    const records = await tx
      .select({
        id: correspondence.id,
        messageId: correspondence.messageId,
        sourceEntityId: correspondence.sourceEntityId,
      })
      .from(correspondence)
      .where(eq(correspondence.workspaceId, fixture.workspaceId))
      .orderBy(asc(correspondence.messageId));
    const sources = await tx
      .select({
        correspondenceId: correspondenceSources.correspondenceId,
        entityId: correspondenceSources.entityId,
      })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.workspaceId, fixture.workspaceId));
    return records.map((record) => ({
      messageId: record.messageId,
      sourceEntityId: record.sourceEntityId,
      sources: sources
        .filter(({ correspondenceId }) => correspondenceId === record.id)
        .map(({ entityId }) => entityId)
        .toSorted(),
    }));
  });

const expectConsistent = (
  state: Awaited<ReturnType<typeof readSourceState>>,
) => {
  for (const record of state) {
    expect(record.sources.length).toBeGreaterThan(0);
    expect(
      record.sources.some((source) => source === record.sourceEntityId),
    ).toBe(true);
  }
  const linked = state.flatMap(({ sources }) => sources);
  expect(new Set(linked).size).toBe(linked.length);
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("concurrent correspondence source changes (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(Boolean(databaseUrl) && runPostgresTests).toBe(false);
    });
  });
} else {
  describe("concurrent correspondence source changes (postgres)", () => {
    test("concurrent uploads and re-filings of copies keep one source set per record", async () => {
      await withGatedTestClients(databaseUrl, async (scope) => {
        const { fixture, sources, cleanUp } = await seedMatter(scope, 2);
        const [first, second] = sources;
        if (first === undefined || second === undefined) {
          throw new Error("Missing copies");
        }
        const writers = [
          scope.openClient({ max: 1 }),
          scope.openClient({ max: 1 }),
        ] as const;
        try {
          // Two copies of one message filed at once converge on one record.
          const filed = await Promise.all([
            fileCopy(writers[0], fixture, first, "9100"),
            fileCopy(writers[1], fixture, second, "9100"),
          ]);
          expect(filed.map(({ type }) => type)).toEqual(["ok", "ok"]);
          const shared = await readSourceState(writers[0], fixture);
          expect(shared).toEqual([
            {
              messageId: "9100",
              sourceEntityId: expect.any(String),
              sources: [first, second].toSorted(),
            },
          ]);
          expectConsistent(shared);

          // Both copies are re-filed as different messages at once: one
          // leaves the shared record, the other takes it over.
          const refiled = await Promise.all([
            fileCopy(writers[0], fixture, first, "9101"),
            fileCopy(writers[1], fixture, second, "9102"),
          ]);
          expect(refiled.map(({ type }) => type)).toEqual(["ok", "ok"]);
          const split = await readSourceState(writers[0], fixture);
          expect(split).toEqual([
            { messageId: "9101", sourceEntityId: first, sources: [first] },
            { messageId: "9102", sourceEntityId: second, sources: [second] },
          ]);
          expectConsistent(split);
        } finally {
          await cleanUp();
        }
      });
    });

    test("re-filing a copy while another copy is removed keeps the record with its survivor", async () => {
      await withGatedTestClients(databaseUrl, async (scope) => {
        const { adminDb, fixture, sources, cleanUp } = await seedMatter(
          scope,
          2,
        );
        const [removed, survivor] = sources;
        if (removed === undefined || survivor === undefined) {
          throw new Error("Missing copies");
        }
        const remover = scope.openClient({ max: 1 });
        const writer = scope.openClient({ max: 1 });
        let release = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          for (const source of sources) {
            const filed = await fileCopy(writer, fixture, source, "9200");
            expect(filed.type).toBe("ok");
          }
          expect(await readSourceState(writer, fixture)).toEqual([
            {
              messageId: "9200",
              sourceEntityId: expect.any(String),
              sources: [removed, survivor].toSorted(),
            },
          ]);

          // The removal unlinks its copy and moves the record to the
          // survivor, then holds its transaction open.
          let removerPid = 0;
          let removedSignal = () => {};
          const removalStarted = new Promise<void>((resolve) => {
            removedSignal = resolve;
          });
          const removal = createScopedDb(
            markRlsDatabase(remover.db),
            [fixture.workspaceId],
            fixture.organizationId,
            fixture.userId,
          )(async (tx) => {
            const [backend] = await tx.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            );
            removerPid = backend?.pid ?? 0;
            await tx
              .delete(entities)
              .where(
                and(
                  eq(entities.id, removed),
                  eq(entities.workspaceId, fixture.workspaceId),
                ),
              );
            removedSignal();
            await released;
          });
          await removalStarted;

          // The survivor is re-filed as another message meanwhile. It must
          // decide whether other copies remain only after the removal
          // committed; deciding on the uncommitted state would unlink the
          // survivor from the record the removal just moved to it.
          const refiled = fileCopy(writer, fixture, survivor, "9201");
          await waitForExternalState({
            description: "the re-filing waits for the removal",
            read: async () =>
              (
                await adminDb.execute<{ waiting: number }>(sql`
                  SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
                  WHERE ${removerPid} = ANY(pg_catalog.pg_blocking_pids(pid))
                `)
              ).at(0)?.waiting === 1,
          });
          release();
          await removal;
          const outcome = await refiled;
          expect(outcome.type).toBe("ok");

          const state = await readSourceState(writer, fixture);
          expect(state).toEqual([
            {
              messageId: "9201",
              sourceEntityId: survivor,
              sources: [survivor],
            },
          ]);
          expectConsistent(state);
        } finally {
          release();
          await cleanUp();
        }
      });
    });

    test("source registration runs as its private role for every record writer", async () => {
      await withGatedTestClients(databaseUrl, async (scope) => {
        const { adminDb, fixture, sources, cleanUp } = await seedMatter(
          scope,
          3,
        );
        const [viaApplication, viaOwner, viaWriter] = sources;
        if (
          viaApplication === undefined ||
          viaOwner === undefined ||
          viaWriter === undefined
        ) {
          throw new Error("Missing copies");
        }
        const suffix = Bun.randomUUIDv7().replaceAll("-", "");
        const writerRole = sql.identifier(
          `source_registration_writer_${suffix}`,
        );
        const writerPolicy = sql.identifier(
          `source_registration_writer_${suffix}`,
        );
        const rolledBack = new Error("Roll back the registration fixture");
        try {
          // The application role files through its own source policies.
          const filed = await fileCopy(
            scope.openClient({ max: 1 }),
            fixture,
            viaApplication,
            "9300",
          );
          expect(filed.type).toBe("ok");

          // The table owner and a role holding no source-table privilege
          // insert uploaded records directly; their trigger still registers
          // each record's own source.
          let registered: { messageId: string | null; entityId: string }[] = [];
          await adminDb
            .transaction(async (tx) => {
              await tx.execute(
                sql`CREATE ROLE ${writerRole} NOLOGIN NOINHERIT`,
              );
              await tx.execute(
                sql`GRANT ${writerRole} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
              );
              await tx.execute(
                sql`GRANT USAGE ON SCHEMA public TO ${writerRole}`,
              );
              await tx.execute(
                sql`GRANT INSERT ON public.correspondence TO ${writerRole}`,
              );
              await tx.execute(sql`
                CREATE POLICY ${writerPolicy} ON public.correspondence
                AS PERMISSIVE FOR INSERT TO CURRENT_USER, ${writerRole}
                WITH CHECK (true)
              `);
              await tx.insert(correspondence).values({
                ...prepareCorrespondenceContent(dataBoxCopy(viaOwner, "9301")),
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
              });
              await tx.execute(sql`SET LOCAL ROLE ${writerRole}`);
              const [privilege] = await tx.execute<{ insert: boolean }>(sql`
                SELECT pg_catalog.has_table_privilege(
                  'public.correspondence_sources', 'INSERT'
                ) AS insert
              `);
              expect(privilege?.insert).toBe(false);
              await tx.insert(correspondence).values({
                ...prepareCorrespondenceContent(dataBoxCopy(viaWriter, "9302")),
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
              });
              await tx.execute(sql`RESET ROLE`);
              await tx.execute(
                sql`SELECT set_config('app.correspondence_review_reset_organization_id', ${fixture.organizationId}, true)`,
              );
              registered = await tx
                .select({
                  messageId: correspondence.messageId,
                  entityId: correspondenceSources.entityId,
                })
                .from(correspondenceSources)
                .innerJoin(
                  correspondence,
                  and(
                    eq(
                      correspondence.id,
                      correspondenceSources.correspondenceId,
                    ),
                    eq(
                      correspondence.workspaceId,
                      correspondenceSources.workspaceId,
                    ),
                  ),
                )
                .where(
                  eq(correspondenceSources.workspaceId, fixture.workspaceId),
                )
                .orderBy(asc(correspondence.messageId));
              // Leave no role, policy or record behind on the shared server.
              throw rolledBack;
            })
            .catch((error: unknown) => {
              if (error !== rolledBack) {
                throw error;
              }
            });
          expect(registered).toEqual([
            { messageId: "9300", entityId: viaApplication },
            { messageId: "9301", entityId: viaOwner },
            { messageId: "9302", entityId: viaWriter },
          ]);
        } finally {
          await cleanUp();
        }
      });
    });
  });
}
