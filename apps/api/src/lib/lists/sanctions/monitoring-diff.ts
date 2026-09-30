import { panic } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { SanctionsSource } from "@stll/sanctions";
import { stableStringify } from "@stll/stable-stringify";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import type { sanctionsScreeningEvents } from "@/api/db/schema";
import {
  contacts,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsContactScreenings,
  sanctionsEditionEntries,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { monitoringFingerprint } from "@/api/lib/lists/sanctions/monitoring-input";
import { SANCTIONS_SCREENING_BATCH_SIZE } from "@/api/lib/lists/sanctions/screening-service";
import type {
  SanctionsListOutcome,
  SanctionsPossibleMatch,
} from "@/api/lib/lists/sanctions/screening-service";
import { commitReplaySafeIngestionBatch } from "@/api/lib/replay-safe-ingestion";

export const SANCTIONS_MONITORING_BATCH_SIZE = SANCTIONS_SCREENING_BATCH_SIZE;
const MATCHES_PER_CONTACT = 1000;

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
  now?: Date;
  claim?: {
    leaseExpiresAt: Date;
    marks: readonly { contactId: SafeId<"contact">; generation: bigint }[];
  };
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
}: MatchTransitionOptions): "new" | "reopened" | "changed" | null => {
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
  dismissed: "review-dismissed",
  "review-restored": "review-restored",
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
      status: outcome.status,
      reason: null,
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
    await tx.execute(sql`
      INSERT INTO sanctions_contact_matches
        (organization_id, contact_id, source_id, source_entry_id, edition_id, state,
         disposition, reviewed_by, review_reason, contact_fingerprint, entry_hash, match, updated_at)
      SELECT x."organizationId", x."contactId", x."sourceId", x."sourceEntryId", x."editionId",
        x.state, x.disposition, x."reviewedBy", x."reviewReason", x."contactFingerprint", x."entryHash", x.match, x."updatedAt"
      FROM jsonb_to_recordset(${JSON.stringify(matches)}::text::jsonb) AS x(
        "organizationId" varchar(128), "contactId" uuid, "sourceId" text, "sourceEntryId" text,
        "editionId" uuid, state text, disposition text, "reviewedBy" text, "reviewReason" text,
        "contactFingerprint" text, "entryHash" text, match jsonb, "updatedAt" timestamptz)
      ON CONFLICT (organization_id, contact_id, source_id, source_entry_id) DO UPDATE SET
        edition_id = excluded.edition_id, state = excluded.state, disposition = excluded.disposition,
        reviewed_by = excluded.reviewed_by, review_reason = excluded.review_reason,
        contact_fingerprint = excluded.contact_fingerprint, entry_hash = excluded.entry_hash,
        match = excluded.match, updated_at = excluded.updated_at
    `);
  }
  if (events.length > 0) {
    await tx.execute(sql`
      INSERT INTO sanctions_screening_events
        (id, organization_id, contact_id, source_id, source_entry_id, type, old_edition_id,
         new_edition_id, reason, old_match, new_match, created_at)
      SELECT gen_random_uuid(), x."organizationId", x."contactId", x."sourceId", x."sourceEntryId",
        x.type, x."oldEditionId", x."newEditionId", x.reason, x."oldMatch", x."newMatch", x."createdAt"
      FROM jsonb_to_recordset(${JSON.stringify(events)}::text::jsonb) AS x(
        "organizationId" varchar(128), "contactId" uuid, "sourceId" text, "sourceEntryId" text,
        type text, "oldEditionId" uuid, "newEditionId" uuid, reason text, "oldMatch" jsonb,
        "newMatch" jsonb, "createdAt" timestamptz)
    `);
  }
};

type LoadMonitoringDiffOptions = Pick<
  BuildMonitoringDiffOptions,
  "organizationId" | "source" | "editionId" | "eligible"
> & { tx: Transaction };

const loadMonitoringDiff = async ({
  tx,
  organizationId,
  source,
  editionId,
  eligible,
}: LoadMonitoringDiffOptions) => {
  const oldRows = await tx
    .select()
    .from(sanctionsContactMatches)
    .where(
      and(
        eq(sanctionsContactMatches.organizationId, organizationId),
        eq(sanctionsContactMatches.sourceId, source),
        inArray(
          sanctionsContactMatches.contactId,
          eligible.map(({ contactId }) => contactId),
        ),
      ),
    )
    .limit(eligible.length * MATCHES_PER_CONTACT + 1);
  const oldCounts = new Map<SafeId<"contact">, number>();
  for (const row of oldRows) {
    const count = (oldCounts.get(row.contactId) ?? 0) + 1;
    if (count > MATCHES_PER_CONTACT) {
      panic("Monitoring match history exceeds its per-contact bound");
    }
    oldCounts.set(row.contactId, count);
  }
  const hitIds = [
    ...new Set(
      eligible.flatMap(({ outcome }) =>
        outcome.possibleMatches.map((hit) => hit.sourceEntryId),
      ),
    ),
  ];
  const hashes =
    hitIds.length === 0
      ? []
      : await tx
          .select()
          .from(sanctionsEditionEntries)
          .where(
            and(
              eq(sanctionsEditionEntries.editionId, editionId),
              sql`${sanctionsEditionEntries.sourceEntryId} = ANY(${sql.param(hitIds)}::text[])`,
            ),
          )
          .limit(hitIds.length);
  const hashByEntry = new Map(
    hashes.map((row) => [row.sourceEntryId, row.contentHash]),
  );
  return { oldRows, hashByEntry };
};

/**
 * Commit one bounded org/source batch after screening outside the transaction.
 * Contact locks fence mutable inputs; freshness and edition are checked in the transaction. A rejected item
 * keeps its previous coverage, so the caller must retry it before advancing.
 */
export const commitSanctionsMonitoringBatch = async ({
  db,
  organizationId,
  source,
  results,
  now: preparedAt,
  claim,
}: CommitMonitoringBatchOptions) => {
  if (results.length > SANCTIONS_MONITORING_BATCH_SIZE) {
    panic("Sanctions monitoring batch exceeds its bound");
  }
  if (
    new Set(results.map(({ contactId }) => contactId)).size !== results.length
  ) {
    panic("Sanctions monitoring batch contains duplicate contacts");
  }
  const checkpoint: {
    rows: (typeof sanctionsContactScreenings.$inferInsert)[];
  } = { rows: [] };
  return await commitReplaySafeIngestionBatch({
    runInTransaction: db,
    items: results,
    checkpoint,
    persistItems: async (tx, items) => {
      checkpoint.rows = [];
      const terminalContactIds: SafeId<"contact">[] = [];
      if (items.length === 0) {
        return terminalContactIds;
      }
      const settings = (
        await tx
          .select()
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId))
          .limit(1)
          .for("no key update")
      ).at(0);
      // Missing settings use the enabled default.
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
        .for("no key update");
      // Contact writers take contact -> mark; acquire marks only after the ordered contact locks.
      const owned =
        claim === undefined
          ? undefined
          : new Set(
              (
                await tx.execute<{ contactId: SafeId<"contact"> }>(sql`
        SELECT mark.contact_id AS "contactId" FROM sanctions_contact_marks AS mark
        JOIN jsonb_to_recordset(${JSON.stringify(claim.marks.map(({ contactId, generation }) => ({ contactId, generation: generation.toString() })))}::text::jsonb)
          AS claimed("contactId" uuid, generation bigint)
          ON mark.contact_id = claimed."contactId" AND mark.generation = claimed.generation
        WHERE mark.organization_id = ${organizationId} AND mark.scheduled_at = ${claim.leaseExpiresAt}::timestamptz
        ORDER BY mark.contact_id FOR UPDATE OF mark
      `)
              ).map(({ contactId }) => contactId),
            );
      // Durable workers evaluate freshness after acquiring their fences, not at claim time.
      const now = preparedAt ?? new Date();
      const freshness = (
        await readSanctionsFreshness({
          db: async (read) => await read(tx),
          now,
        })
      ).find((row) => row.source === source);
      if (freshness === undefined) {
        panic("Missing sanctions source freshness");
      }
      const editionId = freshness.edition?.id ?? null;
      const byContact = new Map(contactRows.map((row) => [row.id, row]));
      const eligible: SanctionsMonitoringResult[] = [];
      for (const item of items) {
        const contact = byContact.get(item.contactId);
        if (
          contact === undefined ||
          (owned !== undefined && !owned.has(item.contactId))
        ) {
          continue;
        }
        const excluded =
          settings?.sanctionsMonitoringMode === "disabled" ||
          contact.sanctionsMonitoringMode === "excluded";
        if (excluded) {
          checkpoint.rows.push({
            organizationId,
            contactId: contact.id,
            sourceId: source,
            editionId: null,
            status: "excluded",
            reason:
              settings?.sanctionsMonitoringMode === "disabled"
                ? "monitoring-disabled"
                : "contact-excluded",
            contactFingerprint: monitoringFingerprint(contact),
            checkedAt: now,
          });
          terminalContactIds.push(contact.id);
          continue;
        }
        if (
          monitoringFingerprint(contact) !== item.contactFingerprint ||
          item.outcome.source !== source
        ) {
          continue;
        }
        if (
          freshness.status === "unavailable" ||
          item.outcome.status === "unavailable"
        ) {
          checkpoint.rows.push({
            organizationId,
            contactId: contact.id,
            sourceId: source,
            editionId,
            status: "unavailable",
            reason: freshness.reason ?? item.outcome.reason,
            contactFingerprint: item.contactFingerprint,
            checkedAt: now,
          });
          terminalContactIds.push(contact.id);
          continue;
        }
        if (item.outcome.editionId === editionId) {
          eligible.push(item);
        }
      }
      if (eligible.length === 0) {
        return terminalContactIds;
      }
      if (editionId === null) {
        panic("Fresh monitoring edition missing");
      }
      for (const { outcome } of eligible) {
        if (
          outcome.truncated ||
          outcome.possibleMatches.length > MATCHES_PER_CONTACT
        ) {
          panic("Monitoring requires the complete sanctions result set");
        }
      }
      const { oldRows, hashByEntry } = await loadMonitoringDiff({
        tx,
        organizationId,
        source,
        editionId,
        eligible,
      });
      const diff = buildMonitoringDiff({
        organizationId,
        source,
        editionId,
        eligible,
        oldRows,
        hashByEntry,
        now,
      });
      checkpoint.rows.push(...diff.screenings);
      terminalContactIds.push(...diff.terminalContactIds);
      await persistMonitoringDiff(tx, diff);
      return terminalContactIds;
    },
    persistCheckpoint: async (tx, { rows }) => {
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
            status: sql`excluded.status`,
            reason: sql`excluded.reason`,
          },
        });
    },
  });
};
