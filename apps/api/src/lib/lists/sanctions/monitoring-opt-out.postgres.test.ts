import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  DOCUMENT_PROCESSING_MODE,
  contacts,
  auditLogs,
  sanctionsContactMarks,
  sanctionsOrganizationMarks,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsContactScreenings,
  sanctionsEditions,
  sanctionsSources,
  sanctionsScreeningEvents,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { commitSanctionsMonitoringBatch } from "./monitoring-diff";
import { monitoringFingerprint } from "./monitoring-input";
import {
  disableSanctionsMonitoring,
  excludeSanctionsContact,
  includeSanctionsContact,
  enableSanctionsMonitoring,
} from "./monitoring-opt-out";
import type { SanctionsPossibleMatch } from "./screening-service";
import { sanctionsSourceIds, SANCTIONS_SOURCE_CONFIG } from "./source-config";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!runPostgresTests || databaseUrl === undefined) {
  describe.skip("concurrent sanctions firm opt-out", () => {
    test("requires the migrated PostgreSQL test profile", () => {
      expect(runPostgresTests && databaseUrl !== undefined).toBe(false);
    });
  });
} else {
  test("re-enabling persists refresh marks with its audit and rolls back both on audit failure", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const admin = openClient().db;
      const organizationId = mintAuthProviderId<"organization">();
      await admin.insert(organization).values({
        id: organizationId,
        name: "Monitoring audit fixture",
        slug: organizationId,
        createdAt: new Date(),
      });
      try {
        const contact =
          (
            await admin
              .insert(contacts)
              .values({
                organizationId,
                type: "person",
                displayName: "Synthetic Person",
                sanctionsMonitoringMode: "excluded",
              })
              .returning()
          ).at(0) ?? panic("Contact fixture missing");
        await admin.insert(organizationSettings).values({
          id: createSafeId<"organizationSettings">(),
          organizationId,
          sanctionsMonitoringMode: "disabled",
        });
        const recordAuditEvent = createBackgroundAuditRecorder({
          organizationId,
          workspaceId: null,
          userId: "system:sanctions-monitoring-drain",
          execution: {
            performer: {
              type: "service",
              id: "system:sanctions-monitoring-drain",
              name: "Monitoring fixture",
            },
            trigger: { type: "system" },
          },
        });
        const mutate = async (fail: boolean) =>
          await admin.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE stella`);
            await tx.execute(
              sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
            );
            const options = {
              organizationId,
              recordAuditEvent: fail
                ? async () => panic("Synthetic refresh audit failure")
                : recordAuditEvent,
            };
            (
              await includeSanctionsContact(tx, {
                ...options,
                contactId: contact.id,
              })
            ).unwrap();
            await enableSanctionsMonitoring(tx, options);
          });
        const census = async () => ({
          contacts: await admin
            .select()
            .from(contacts)
            .where(eq(contacts.organizationId, organizationId)),
          settings: await admin
            .select()
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, organizationId)),
          contactMarks: await admin
            .select()
            .from(sanctionsContactMarks)
            .where(eq(sanctionsContactMarks.organizationId, organizationId)),
          firmMarks: await admin
            .select()
            .from(sanctionsOrganizationMarks)
            .where(
              eq(sanctionsOrganizationMarks.organizationId, organizationId),
            ),
          audits: await admin
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId)),
        });
        const before = await census();
        expect(String(await rejectionOf(mutate(true)))).toContain(
          "Synthetic refresh audit failure",
        );
        expect(await census()).toEqual(before);
        await mutate(false);
        const after = await census();
        expect(after.contactMarks).toHaveLength(1);
        expect(after.firmMarks).toHaveLength(1);
        expect(after.audits).toHaveLength(2);
        expect(after.audits.map((row) => row.metadata)).toEqual([
          { monitoringMarkCount: 1 },
          { monitoringMarkCount: 1 },
        ]);
        await mutate(false);
        expect(await census()).toEqual(after);
      } finally {
        await admin
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
    });
  }, 60_000);

  test("general settings and monitoring preserve the first unique-key row in either order", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      for (const firstWriter of ["general", "monitoring"] as const) {
        const admin = openClient().db;
        const generalDb = openClient().db;
        const monitoringDb = openClient().db;
        const organizationId = mintAuthProviderId<"organization">();
        const generalSettingsId = createSafeId<"organizationSettings">();
        const generalUserId = mintAuthProviderId<"user">();
        const monitoringUserId = mintAuthProviderId<"user">();
        const firstReady = Promise.withResolvers<undefined>();
        const secondStarted = Promise.withResolvers<undefined>();
        const releaseFirst = Promise.withResolvers<undefined>();
        let monitoringSettingsId: typeof generalSettingsId | undefined;
        let firstTransaction: Promise<void> | undefined;
        let secondTransaction: Promise<void> | undefined;
        let firstPid: number | undefined;
        let secondPid: number | undefined;

        const generalAudit = createBackgroundAuditRecorder({
          organizationId,
          workspaceId: null,
          userId: generalUserId,
          execution: {
            performer: { type: "user", id: generalUserId },
            trigger: { type: "direct" },
          },
        });
        const monitoringAudit = createBackgroundAuditRecorder({
          organizationId,
          workspaceId: null,
          userId: monitoringUserId,
          execution: {
            performer: { type: "user", id: monitoringUserId },
            trigger: { type: "direct" },
          },
        });
        const generalWrite = async (hold: boolean) =>
          await generalDb.transaction(async (tx) => {
            const pid =
              (
                await tx.execute<{ pid: number }>(
                  sql`SELECT pg_backend_pid() AS pid`,
                )
              ).at(0)?.pid ?? panic("General settings backend missing");
            if (hold) {
              firstPid = pid;
            } else {
              secondPid = pid;
              secondStarted.resolve(undefined);
            }
            await tx.execute(sql`SET LOCAL ROLE stella`);
            await tx.execute(
              sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
            );
            await tx
              .insert(organizationSettings)
              .values({
                id: generalSettingsId,
                organizationId,
                documentProcessingMode:
                  DOCUMENT_PROCESSING_MODE.SEARCHABLE_TEXT,
              })
              .onConflictDoUpdate({
                target: organizationSettings.organizationId,
                set: {
                  documentProcessingMode:
                    DOCUMENT_PROCESSING_MODE.SEARCHABLE_TEXT,
                  updatedAt: new Date(),
                },
              });
            await generalAudit(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
              resourceId: organizationId,
              changes: {
                documentProcessingMode: {
                  old: DOCUMENT_PROCESSING_MODE.OFF,
                  new: DOCUMENT_PROCESSING_MODE.SEARCHABLE_TEXT,
                },
              },
            });
            if (hold) {
              firstReady.resolve(undefined);
              await releaseFirst.promise;
            }
          });
        const monitoringWrite = async (hold: boolean) =>
          await monitoringDb.transaction(async (tx) => {
            const pid =
              (
                await tx.execute<{ pid: number }>(
                  sql`SELECT pg_backend_pid() AS pid`,
                )
              ).at(0)?.pid ?? panic("Monitoring settings backend missing");
            if (hold) {
              firstPid = pid;
            } else {
              secondPid = pid;
              secondStarted.resolve(undefined);
            }
            await tx.execute(sql`SET LOCAL ROLE stella`);
            await tx.execute(
              sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
            );
            await enableSanctionsMonitoring(tx, {
              organizationId,
              recordAuditEvent: monitoringAudit,
            });
            const settings =
              (
                await tx
                  .select({ id: organizationSettings.id })
                  .from(organizationSettings)
                  .where(
                    eq(organizationSettings.organizationId, organizationId),
                  )
              ).at(0) ??
              panic("Monitoring settings row missing in transaction");
            monitoringSettingsId = settings.id;
            if (hold) {
              firstReady.resolve(undefined);
              await releaseFirst.promise;
            }
          });

        try {
          await admin.insert(organization).values({
            id: organizationId,
            name: "Settings natural-key race",
            slug: organizationId,
            createdAt: new Date(),
          });
          const first =
            firstWriter === "general"
              ? generalWrite(true)
              : monitoringWrite(true);
          firstTransaction = first;
          await Promise.race([
            firstReady.promise,
            first.then(() =>
              panic("First settings writer finished before barrier"),
            ),
          ]);

          const second =
            firstWriter === "general"
              ? monitoringWrite(false)
              : generalWrite(false);
          secondTransaction = second;
          await Promise.race([
            secondStarted.promise,
            second.then(() =>
              panic("Second settings writer finished before conflict"),
            ),
          ]);
          const awaitedPid =
            secondPid ?? panic("Second settings writer PID missing");
          let blockers: number[] = [];
          for (let attempt = 0; attempt < 200; attempt += 1) {
            blockers =
              (
                await admin.execute<{ blockers: number[] }>(
                  sql`SELECT pg_blocking_pids(${awaitedPid}) AS blockers`,
                )
              ).at(0)?.blockers ?? [];
            if (firstPid !== undefined && blockers.includes(firstPid)) {
              break;
            }
          }
          expect(blockers).toContain(
            firstPid ?? panic("First settings writer PID missing"),
          );
          releaseFirst.resolve(undefined);
          await Promise.all([first, second]);

          const settings =
            (
              await admin
                .select()
                .from(organizationSettings)
                .where(eq(organizationSettings.organizationId, organizationId))
            ).at(0) ?? panic("Settings race did not persist settings");
          const expectedSettingsId =
            (firstWriter === "general"
              ? generalSettingsId
              : monitoringSettingsId) ??
            panic("First settings writer did not capture its row ID");
          expect(settings.id).toBe(expectedSettingsId);
          expect(settings.sanctionsMonitoringMode).toBe("enabled");
          expect(settings.documentProcessingMode).toBe(
            DOCUMENT_PROCESSING_MODE.SEARCHABLE_TEXT,
          );
          expect(
            await admin
              .select()
              .from(sanctionsOrganizationMarks)
              .where(
                eq(sanctionsOrganizationMarks.organizationId, organizationId),
              ),
          ).toHaveLength(1);
          const events = await admin
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId));
          const expectedAuditUsers =
            firstWriter === "general"
              ? [generalUserId]
              : [generalUserId, monitoringUserId];
          expect(events.map(({ userId }) => userId).toSorted()).toEqual(
            expectedAuditUsers.toSorted(),
          );
          expect(
            events.filter(({ userId }) => userId === generalUserId),
          ).toHaveLength(1);
          expect(
            events.filter(({ userId }) => userId === monitoringUserId),
          ).toHaveLength(firstWriter === "general" ? 0 : 1);
          expect(
            events.filter(({ changes }) =>
              Object.hasOwn(changes ?? {}, "documentProcessingMode"),
            ),
          ).toHaveLength(1);
          expect(
            events.filter(({ changes }) =>
              Object.hasOwn(changes ?? {}, "sanctionsMonitoringMode"),
            ),
          ).toHaveLength(firstWriter === "general" ? 0 : 1);
        } finally {
          releaseFirst.resolve(undefined);
          await Promise.allSettled(
            [firstTransaction, secondTransaction].filter(
              (transaction) => transaction !== undefined,
            ),
          );
          await admin
            .delete(organization)
            .where(eq(organization.id, organizationId));
        }
      }
    });
  }, 60_000);

  for (const operation of [
    "serial-disable",
    "commit-first",
    "disable-first",
    "contact-exclude",
  ] as const) {
    test(`stored coverage and evidence survive ${operation}`, async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const admin = openClient().db;
        const commitDb = openClient().db;
        const optOutDb = openClient().db;
        const organizationId = mintAuthProviderId<"organization">();
        const editionId = createSafeId<"sanctionsEdition">();
        const seededAt = new Date("2026-09-29T12:00:00Z");
        const now = new Date("2026-09-29T12:01:00Z");
        const editionHash = createHash("sha256")
          .update(editionId)
          .digest("hex");
        const sources = sanctionsSourceIds();
        const existingSources = await admin.select().from(sanctionsSources);
        const missingSources = sources.filter(
          (source) => !existingSources.some((row) => row.id === source),
        );
        await admin.insert(organization).values({
          id: organizationId,
          name: "Synthetic monitoring organization",
          slug: organizationId,
          createdAt: now,
        });
        try {
          await admin.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
            if (missingSources.length > 0) {
              await tx.insert(sanctionsSources).values(
                missingSources.map((id) => ({
                  id,
                  issuer: SANCTIONS_SOURCE_CONFIG[id].issuer,
                  markerUrl: "https://example.test/list",
                })),
              );
            }
            await tx.insert(sanctionsEditions).values({
              id: editionId,
              sourceId: "eu",
              markerKey: editionHash,
              contentHash: editionHash,
              publishedAt: "2026-09-29",
              state: "ready",
              entryCount: 0,
            });
          });
          const contact =
            (
              await admin
                .insert(contacts)
                .values({
                  organizationId,
                  type: "person",
                  displayName: "Synthetic Person",
                })
                .returning()
            ).at(0) ?? panic("Contact missing");
          const fingerprint = monitoringFingerprint(contact);
          const match = {
            sourceEntryId: "synthetic",
            editionId,
            score: 1,
            sourceUrl: "https://example.test/list",
            name: "Synthetic Person",
            referenceNumber: null,
            entityType: "person",
            programme: null,
            listedOn: null,
            evidence: {
              nameScore: 1,
              matchedName: "Synthetic Person",
              birthDate: "not-compared",
              nationality: "not-compared",
              entityType: "match",
              identifier: "not-compared",
              conflicts: [],
            },
          } satisfies SanctionsPossibleMatch;
          await admin.insert(sanctionsContactMatches).values({
            organizationId,
            contactId: contact.id,
            sourceId: "eu",
            sourceEntryId: match.sourceEntryId,
            editionId,
            state: "active",
            contactFingerprint: fingerprint,
            entryHash: editionHash,
            match,
            updatedAt: seededAt,
          });
          await admin.insert(sanctionsScreeningEvents).values({
            organizationId,
            contactId: contact.id,
            sourceId: "eu",
            sourceEntryId: match.sourceEntryId,
            type: "new",
            newEditionId: editionId,
            reason: "new-possible-match",
            contactFingerprint: fingerprint,
            entryHash: editionHash,
            newMatch: match,
            createdAt: seededAt,
          });
          // Seed every configured key: losing any row must fail even if a raced
          // commit recreates its own source's coverage after a destructive opt-out.
          await admin.insert(sanctionsContactScreenings).values(
            sources.map((sourceId) => ({
              organizationId,
              contactId: contact.id,
              sourceId,
              editionId: sourceId === "eu" ? editionId : null,
              status: "possible-match" as const,
              contactFingerprint: fingerprint,
              checkedAt: seededAt,
            })),
          );
          const readCoverage = async () =>
            await admin
              .select()
              .from(sanctionsContactScreenings)
              .where(
                and(
                  eq(sanctionsContactScreenings.organizationId, organizationId),
                  eq(sanctionsContactScreenings.contactId, contact.id),
                ),
              )
              .orderBy(sanctionsContactScreenings.sourceId);
          const readMatches = async () =>
            await admin
              .select()
              .from(sanctionsContactMatches)
              .where(
                and(
                  eq(sanctionsContactMatches.organizationId, organizationId),
                  eq(sanctionsContactMatches.contactId, contact.id),
                ),
              )
              .orderBy(
                sanctionsContactMatches.sourceId,
                sanctionsContactMatches.sourceEntryId,
              );
          const readHistory = async () =>
            await admin
              .select()
              .from(sanctionsScreeningEvents)
              .where(
                and(
                  eq(sanctionsScreeningEvents.organizationId, organizationId),
                  eq(sanctionsScreeningEvents.contactId, contact.id),
                ),
              )
              .orderBy(sanctionsScreeningEvents.id);
          const beforeCoverage = await readCoverage();
          const beforeMatches = await readMatches();
          const beforeHistory = await readHistory();
          expect(beforeCoverage).toHaveLength(sources.length);
          expect(beforeCoverage.length).toBeGreaterThan(1);
          expect(beforeCoverage.map((row) => row.sourceId)).toEqual(
            sources.toSorted(),
          );
          expect(beforeMatches).toHaveLength(1);
          expect(beforeHistory).toHaveLength(1);
          expect(
            await admin.query.organizationSettings.findFirst({
              where: { organizationId: { eq: organizationId } },
            }),
          ).toBeUndefined();
          const firstReady = Promise.withResolvers<undefined>();
          const firstRelease = Promise.withResolvers<undefined>();
          const commitFirst = operation === "commit-first";
          const disableFirst = operation === "disable-first";
          const scopedFor =
            (db: GatedTestDb, hold: boolean): ScopedDb =>
            async (run) =>
              await db.transaction(async (tx) => {
                await tx.execute(sql`SET LOCAL ROLE stella`);
                await tx.execute(
                  sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
                );
                const result = await run(tx);
                if (hold) {
                  firstReady.resolve(undefined);
                  await firstRelease.promise;
                }
                return result;
              });
          const scopedDb = scopedFor(commitDb, commitFirst);
          const prepared = {
            contactId: contact.id,
            contactFingerprint: fingerprint,
            outcome: {
              source: "eu",
              issuer: "EU",
              classification: "informational",
              status: "unavailable",
              reason: "load-failed",
              editionId: null,
              publishedAt: null,
              verifiedAt: null,
              pendingUpdate: null,
              totalMatches: 0,
              truncated: false,
              possibleMatches: [],
            },
          } satisfies Parameters<
            typeof commitSanctionsMonitoringBatch
          >[0]["results"][number];
          const commit = async () =>
            await commitSanctionsMonitoringBatch({
              db: scopedDb,
              organizationId,
              source: "eu",
              results: [prepared],
              now,
            });
          const disable = async () =>
            await scopedFor(
              optOutDb,
              disableFirst,
            )(
              async (tx) =>
                await disableSanctionsMonitoring(tx, {
                  organizationId,
                  now,
                  recordAuditEvent: async () => undefined,
                }),
            );
          if (operation === "serial-disable") {
            await disable();
          } else if (operation === "contact-exclude") {
            const excluded = await scopedFor(
              optOutDb,
              false,
            )(
              async (tx) =>
                await excludeSanctionsContact(tx, {
                  organizationId,
                  contactId: contact.id,
                  now,
                  recordAuditEvent: async () => undefined,
                }),
            );
            expect(excluded.isOk()).toBe(true);
          } else {
            const pidFor = async (db: GatedTestDb) =>
              (
                await db.execute<{ pid: number }>(
                  sql`SELECT pg_backend_pid() AS pid`,
                )
              ).at(0)?.pid ?? panic("Missing race backend");
            const commitPid = await pidFor(commitDb);
            const disablePid = await pidFor(optOutDb);
            const first = commitFirst ? commit() : disable();
            let second: Promise<unknown> | undefined;
            try {
              // First writer has completed its mutation and holds the transaction
              // fence; the second must be observed waiting on that exact backend.
              await Promise.race([
                firstReady.promise,
                first.then(() =>
                  panic("First writer finished without reaching its barrier"),
                ),
              ]);
              second = commitFirst ? disable() : commit();
              const firstPid = commitFirst ? commitPid : disablePid;
              const secondPid = commitFirst ? disablePid : commitPid;
              let blockers: number[] = [];
              for (let attempt = 0; attempt < 200; attempt += 1) {
                blockers =
                  (
                    await admin.execute<{ blockers: number[] }>(
                      sql`SELECT pg_blocking_pids(${secondPid}) AS blockers`,
                    )
                  ).at(0)?.blockers ?? [];
                if (blockers.includes(firstPid)) {
                  break;
                }
                await Bun.sleep(10);
              }
              expect(blockers).toContain(firstPid);
            } finally {
              firstRelease.resolve(undefined);
              await Promise.all([first, second]);
            }
          }
          const coverage = await readCoverage();
          expect(coverage).toHaveLength(beforeCoverage.length);
          expect(
            coverage.map(({ organizationId: org, contactId, sourceId }) => ({
              organizationId: org,
              contactId,
              sourceId,
            })),
          ).toEqual(
            beforeCoverage.map(
              ({ organizationId: org, contactId, sourceId }) => ({
                organizationId: org,
                contactId,
                sourceId,
              }),
            ),
          );
          const expectedReason =
            operation === "contact-exclude"
              ? "contact-excluded"
              : "monitoring-disabled";
          expect(
            coverage.map(
              ({
                sourceId,
                status,
                reason,
                editionId: storedEditionId,
                checkedAt,
              }) => ({
                sourceId,
                status,
                reason,
                editionId: storedEditionId,
                checkedAt,
              }),
            ),
          ).toEqual(
            sources.toSorted().map((sourceId) => ({
              sourceId,
              status: "excluded",
              reason: expectedReason,
              editionId: null,
              checkedAt: now,
            })),
          );
          expect(await readMatches()).toEqual(
            beforeMatches.map((row) => ({
              ...row,
              state: "lapsed",
              updatedAt: now,
            })),
          );
          expect(await readHistory()).toEqual(beforeHistory);
          if (operation === "contact-exclude") {
            expect(
              (
                await admin
                  .select()
                  .from(contacts)
                  .where(eq(contacts.id, contact.id))
              ).at(0)?.sanctionsMonitoringMode,
            ).toBe("excluded");
          } else {
            expect(
              (
                await admin
                  .select()
                  .from(organizationSettings)
                  .where(
                    eq(organizationSettings.organizationId, organizationId),
                  )
              ).at(0)?.sanctionsMonitoringMode,
            ).toBe("disabled");
          }
        } finally {
          await admin
            .delete(organization)
            .where(eq(organization.id, organizationId));
          // Fixture cleanup uses the owner; ingestion deliberately has no DELETE grant.
          await admin.transaction(async (tx) => {
            await tx
              .delete(sanctionsEditions)
              .where(eq(sanctionsEditions.id, editionId));
            for (const sourceId of missingSources) {
              await tx
                .delete(sanctionsSources)
                .where(eq(sanctionsSources.id, sourceId));
            }
          });
        }
      });
    }, 60_000);
  }
}
