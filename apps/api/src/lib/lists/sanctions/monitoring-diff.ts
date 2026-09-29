import { panic } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { SanctionsSource } from "@stll/sanctions";
import { stableStringify } from "@stll/stable-stringify";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  contacts,
  organization,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsContactScreenings,
  sanctionsEditionEntries,
  sanctionsScreeningEvents,
  sanctionsSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { monitoringFingerprint } from "@/api/lib/lists/sanctions/monitoring-input";
import type {
  SanctionsListOutcome,
  SanctionsPossibleMatch,
} from "@/api/lib/lists/sanctions/screening-service";
import { commitReplaySafeIngestionBatch } from "@/api/lib/replay-safe-ingestion";

export const SANCTIONS_MONITORING_BATCH_SIZE = 100;
const MATCH_READ_PAGE_SIZE = 1000;
const MATCH_WRITE_BATCH_SIZE = 500;

export type SanctionsMonitoringResult = {
  contactId: SafeId<"contact">;
  contactFingerprint: string;
  outcome: SanctionsListOutcome;
};

type CommitMonitoringBatchOptions = {
  db: ScopedDb;
  organizationId: SafeId<"organization">;
  source: SanctionsSource;
  results: readonly SanctionsMonitoringResult[];
  now: Date;
};

const comparableMatch = ({
  editionId: _editionId,
  ...match
}: SanctionsPossibleMatch) => stableStringify(match);

type MatchTransitionOptions = {
  old: typeof sanctionsContactMatches.$inferSelect | undefined;
  identityChanged: boolean;
  hit: SanctionsPossibleMatch;
};

const matchTransition = ({
  old,
  identityChanged,
  hit,
}: MatchTransitionOptions):
  | typeof sanctionsScreeningEvents.$inferSelect.type
  | null => {
  if (old === undefined) {
    return "new";
  }
  if (
    old.state === "lapsed" ||
    (old.disposition === "dismissed" && identityChanged)
  ) {
    return "reopened";
  }
  if (identityChanged || comparableMatch(old.match) !== comparableMatch(hit)) {
    return "changed";
  }
  return null;
};

const EVENT_REASONS = {
  new: "new-hit",
  reopened: "identity-or-membership-changed",
  changed: "evidence-changed",
  lapsed: "absent-from-full-screening",
} as const satisfies Record<
  typeof sanctionsScreeningEvents.$inferSelect.type,
  string
>;

type BuildMonitoringDiffOptions = {
  organizationId: SafeId<"organization">;
  source: SanctionsSource;
  editionId: SafeId<"sanctionsEdition">;
  eligible: readonly SanctionsMonitoringResult[];
  oldRows: (typeof sanctionsContactMatches.$inferSelect)[];
  hashByEntry: ReadonlyMap<string, string>;
  now: Date;
};

const buildMonitoringDiff = ({
  organizationId,
  source,
  editionId,
  eligible,
  oldRows,
  hashByEntry,
  now,
}: BuildMonitoringDiffOptions) => {
  const terminalContactIds: SafeId<"contact">[] = [];
  const screenings: (typeof sanctionsContactScreenings.$inferInsert)[] = [];
  const oldByContact = new Map<SafeId<"contact">, typeof oldRows>();
  for (const row of oldRows) {
    const rows = oldByContact.get(row.contactId);
    if (rows === undefined) {
      oldByContact.set(row.contactId, [row]);
    } else {
      rows.push(row);
    }
  }
  const matches: (typeof sanctionsContactMatches.$inferInsert)[] = [];
  const events: (typeof sanctionsScreeningEvents.$inferInsert)[] = [];
  for (const item of eligible) {
    const { contactId, contactFingerprint, outcome } = item;
    const previous = oldByContact.get(contactId);
    const oldByEntry = new Map(
      previous?.map((row) => [row.sourceEntryId, row]),
    );
    const seen = new Set<string>();
    for (const hit of outcome.possibleMatches) {
      if (hit.editionId !== editionId || seen.has(hit.sourceEntryId)) {
        panic(
          "Monitoring hit has an inconsistent edition or duplicate identity",
        );
      }
      seen.add(hit.sourceEntryId);
      const entryHash =
        hashByEntry.get(hit.sourceEntryId) ??
        panic("Screened sanctions entry is missing");
      const old = oldByEntry.get(hit.sourceEntryId);
      const identityChanged =
        old !== undefined &&
        (old.contactFingerprint !== contactFingerprint ||
          old.entryHash !== entryHash);
      const type = matchTransition({ old, identityChanged, hit });
      const preserveReview =
        old !== undefined && !identityChanged && old.state === "active";
      matches.push({
        organizationId,
        contactId,
        sourceId: source,
        sourceEntryId: hit.sourceEntryId,
        editionId,
        state: "active",
        disposition: preserveReview ? old.disposition : "needs-review",
        reviewedBy: preserveReview ? old.reviewedBy : null,
        reviewReason: preserveReview ? old.reviewReason : null,
        contactFingerprint,
        entryHash,
        match: hit,
        updatedAt: now,
      });
      if (type !== null) {
        events.push({
          organizationId,
          contactId,
          sourceId: source,
          sourceEntryId: hit.sourceEntryId,
          type,
          oldEditionId: old?.editionId ?? null,
          newEditionId: editionId,
          reason: EVENT_REASONS[type],
          oldMatch: old?.match ?? null,
          newMatch: hit,
          createdAt: now,
        });
      }
    }
    for (const old of oldByEntry.values()) {
      if (old.state === "lapsed" || seen.has(old.sourceEntryId)) {
        continue;
      }
      matches.push({ ...old, state: "lapsed", updatedAt: now });
      events.push({
        organizationId,
        contactId,
        sourceId: source,
        sourceEntryId: old.sourceEntryId,
        type: "lapsed",
        oldEditionId: old.editionId,
        newEditionId: editionId,
        reason: "absent-from-full-screening",
        oldMatch: old.match,
        newMatch: null,
        createdAt: now,
      });
    }
    screenings.push({
      organizationId,
      contactId,
      sourceId: source,
      editionId,
      contactFingerprint,
      checkedAt: now,
    });
    terminalContactIds.push(contactId);
  }
  return { matches, events, screenings, terminalContactIds };
};

const persistMonitoringDiff = async (
  tx: Transaction,
  { matches, events }: ReturnType<typeof buildMonitoringDiff>,
) => {
  if (matches.length > 0) {
    for (
      let offset = 0;
      offset < matches.length;
      offset += MATCH_WRITE_BATCH_SIZE
    ) {
      await tx
        .insert(sanctionsContactMatches)
        .values(matches.slice(offset, offset + MATCH_WRITE_BATCH_SIZE))
        .onConflictDoUpdate({
          target: [
            sanctionsContactMatches.organizationId,
            sanctionsContactMatches.contactId,
            sanctionsContactMatches.sourceId,
            sanctionsContactMatches.sourceEntryId,
          ],
          set: {
            editionId: sql`excluded.edition_id`,
            state: sql`excluded.state`,
            disposition: sql`excluded.disposition`,
            reviewedBy: sql`excluded.reviewed_by`,
            reviewReason: sql`excluded.review_reason`,
            contactFingerprint: sql`excluded.contact_fingerprint`,
            entryHash: sql`excluded.entry_hash`,
            match: sql`excluded.match`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  }
  for (
    let offset = 0;
    offset < events.length;
    offset += MATCH_WRITE_BATCH_SIZE
  ) {
    await tx
      .insert(sanctionsScreeningEvents)
      .values(events.slice(offset, offset + MATCH_WRITE_BATCH_SIZE));
  }
};

/**
 * Commit one bounded org/source batch after screening outside the transaction.
 * Locks protect both mutable inputs and the active edition. A rejected item
 * keeps its previous coverage, so the caller must retry it before advancing.
 */
export const commitSanctionsMonitoringBatch = async ({
  db,
  organizationId,
  source,
  results,
  now,
}: CommitMonitoringBatchOptions) => {
  if (results.length > SANCTIONS_MONITORING_BATCH_SIZE) {
    panic("Sanctions monitoring batch exceeds its bound");
  }
  if (
    new Set(results.map(({ contactId }) => contactId)).size !== results.length
  ) {
    panic("Sanctions monitoring batch contains duplicate contacts");
  }
  const terminalContactIds: SafeId<"contact">[] = [];
  const screenings: (typeof sanctionsContactScreenings.$inferInsert)[] = [];
  return await commitReplaySafeIngestionBatch({
    runInTransaction: db,
    items: results,
    checkpoint: screenings,
    persistItems: async (tx, items) => {
      if (items.length === 0) {
        return terminalContactIds;
      }
      await tx
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, organizationId))
        .limit(1)
        .for("update");
      const settings = (
        await tx
          .select()
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId))
          .limit(1)
          .for("update")
      ).at(0);
      // The organization lock also fences insertion of previously absent settings.
      // Missing settings use the enabled default.
      if (settings?.sanctionsMonitoringMode === "disabled") {
        return terminalContactIds;
      }
      const ids = items.map(({ contactId }) => contactId);
      const contactRows = await tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, organizationId),
            inArray(contacts.id, ids),
          ),
        )
        .orderBy(asc(contacts.id))
        .limit(SANCTIONS_MONITORING_BATCH_SIZE)
        .for("update");
      await tx
        .select({ id: sanctionsSources.id })
        .from(sanctionsSources)
        .where(eq(sanctionsSources.id, source))
        .limit(1)
        .for("share");
      const freshness = (
        await readSanctionsFreshness({
          db: async (read) => await read(tx),
          now,
        })
      ).find((row) => row.source === source);
      if (freshness === undefined) {
        panic("Missing sanctions source freshness");
      }
      if (freshness.status !== "fresh" || freshness.edition === null) {
        return terminalContactIds;
      }
      const editionId = freshness.edition.id;
      const byContact = new Map(contactRows.map((row) => [row.id, row]));
      const eligible = items.filter(
        ({ contactId, contactFingerprint, outcome }) => {
          const contact = byContact.get(contactId);
          return (
            contact !== undefined &&
            contact.sanctionsMonitoringMode === "included" &&
            monitoringFingerprint(contact) === contactFingerprint &&
            outcome.source === source &&
            outcome.status !== "unavailable" &&
            outcome.editionId === editionId
          );
        },
      );
      if (eligible.length === 0) {
        return terminalContactIds;
      }
      for (const { outcome } of eligible) {
        if (outcome.truncated) {
          panic("Monitoring requires the complete sanctions result set");
        }
      }
      const oldRows: (typeof sanctionsContactMatches.$inferSelect)[] = [];
      let cursor: { contactId: string; sourceEntryId: string } | undefined;
      for (;;) {
        const page = await tx
          .select()
          .from(sanctionsContactMatches)
          .where(
            and(
              eq(sanctionsContactMatches.organizationId, organizationId),
              eq(sanctionsContactMatches.sourceId, source),
              inArray(sanctionsContactMatches.contactId, ids),
              cursor === undefined
                ? undefined
                : sql`(${sanctionsContactMatches.contactId}, ${sanctionsContactMatches.sourceEntryId}) > (${cursor.contactId}::uuid, ${cursor.sourceEntryId})`,
            ),
          )
          .orderBy(
            asc(sanctionsContactMatches.contactId),
            asc(sanctionsContactMatches.sourceEntryId),
          )
          .limit(MATCH_READ_PAGE_SIZE);
        oldRows.push(...page);
        const last = page.at(-1);
        if (page.length < MATCH_READ_PAGE_SIZE || last === undefined) {
          break;
        }
        cursor = {
          contactId: last.contactId,
          sourceEntryId: last.sourceEntryId,
        };
      }
      const hitIds = [
        ...new Set(
          eligible.flatMap(({ outcome }) =>
            outcome.possibleMatches.map((hit) => hit.sourceEntryId),
          ),
        ),
      ];
      const hashByEntry = new Map<string, string>();
      for (
        let offset = 0;
        offset < hitIds.length;
        offset += MATCH_WRITE_BATCH_SIZE
      ) {
        const hashes = await tx
          .select()
          .from(sanctionsEditionEntries)
          .where(
            and(
              eq(sanctionsEditionEntries.editionId, editionId),
              inArray(
                sanctionsEditionEntries.sourceEntryId,
                hitIds.slice(offset, offset + MATCH_WRITE_BATCH_SIZE),
              ),
            ),
          )
          .limit(MATCH_WRITE_BATCH_SIZE);
        for (const row of hashes) {
          hashByEntry.set(row.sourceEntryId, row.contentHash);
        }
      }
      const diff = buildMonitoringDiff({
        organizationId,
        source,
        editionId,
        eligible,
        oldRows,
        hashByEntry,
        now,
      });
      screenings.push(...diff.screenings);
      terminalContactIds.push(...diff.terminalContactIds);
      await persistMonitoringDiff(tx, diff);
      return terminalContactIds;
    },
    persistCheckpoint: async (tx, rows) => {
      if (rows.length === 0) {
        return;
      }
      await tx
        .insert(sanctionsContactScreenings)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            sanctionsContactScreenings.organizationId,
            sanctionsContactScreenings.contactId,
            sanctionsContactScreenings.sourceId,
          ],
          set: {
            editionId: sql`excluded.edition_id`,
            contactFingerprint: sql`excluded.contact_fingerprint`,
            checkedAt: sql`excluded.checked_at`,
          },
        });
    },
  });
};
