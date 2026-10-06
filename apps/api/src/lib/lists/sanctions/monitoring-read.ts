import { panic, Result } from "better-result";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { isCountryCode } from "@stll/country-codes";
import { SANCTIONS_SOURCES } from "@stll/sanctions";

import type { Transaction } from "@/api/db/root";
import {
  contacts,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsContactScreenings,
  sanctionsContactMarks,
  sanctionsScreeningEvents,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { loadPracticeJurisdictions } from "@/api/lib/db/practice-jurisdictions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { classifySanctionsIssuer } from "@/api/lib/lists/sanctions/classification";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { monitoringFingerprint } from "@/api/lib/lists/sanctions/monitoring-input";
import { SANCTIONS_NOTIFICATION_EVENT_TYPES } from "@/api/lib/lists/sanctions/monitoring-vocabulary";
import {
  isSanctionsSource,
  sanctionsSourceIds,
} from "@/api/lib/lists/sanctions/source-config";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  parseDateTimePaginationCursorPart,
} from "@/api/lib/pagination";

export const SANCTIONS_MONITORING_PAGE_SIZE = 100;
const loadMonitoringClassifier = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) => {
  const practiceJurisdictions = (
    await loadPracticeJurisdictions({
      scopedDb: async (read) => await read(tx),
      organizationId,
    })
  )
    .map((row) => row.countryCode)
    .filter(isCountryCode);
  return (source: string) => {
    if (!isSanctionsSource(source)) {
      panic("Persisted monitoring match has an unknown source");
    }
    return classifySanctionsIssuer(
      SANCTIONS_SOURCES[source].issuer,
      practiceJurisdictions,
    );
  };
};

const invalidCursor = (
  capability:
    | "contacts.sanctions.get"
    | "contacts.sanctions.matches.list"
    | "contacts.sanctions.events.list",
) =>
  Result.err(
    new HandlerError({
      status: 400,
      code: "invalid_cursor",
      message: `Invalid sanctions cursor; call ${capability} without cursor to restart`,
    }),
  );

export const readContactSanctions = async (
  tx: Transaction,
  {
    organizationId,
    contactId,
    cursor,
    limit = SANCTIONS_MONITORING_PAGE_SIZE,
    now = new Date(),
  }: {
    organizationId: SafeId<"organization">;
    contactId: SafeId<"contact">;
    cursor?: string | undefined;
    limit?: number;
    now?: Date;
  },
) => {
  const position = cursor === undefined ? null : decodePaginationCursor(cursor);
  if (
    cursor !== undefined &&
    (position?.length !== 4 ||
      position.at(0) !== organizationId ||
      position.at(1) !== contactId ||
      typeof position.at(2) !== "string" ||
      typeof position.at(3) !== "string")
  ) {
    return invalidCursor("contacts.sanctions.get");
  }
  const afterSource = position?.at(2);
  const afterEntry = position?.at(3);
  const contact = (
    await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          eq(contacts.id, contactId),
        ),
      )
      .limit(1)
  ).at(0);
  if (contact === undefined) {
    return Result.err(
      new HandlerError({ status: 404, message: "Contact not found" }),
    );
  }
  const settings = (
    await tx
      .select({ mode: organizationSettings.sanctionsMonitoringMode })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1)
  ).at(0);
  const firmMode = settings?.mode ?? "enabled";
  const excluded =
    firmMode === "disabled" || contact.sanctionsMonitoringMode === "excluded";
  const screenings = await tx
    .select()
    .from(sanctionsContactScreenings)
    .where(
      and(
        eq(sanctionsContactScreenings.organizationId, organizationId),
        eq(sanctionsContactScreenings.contactId, contactId),
      ),
    )
    .limit(sanctionsSourceIds().length);
  const freshness = await readSanctionsFreshness({
    db: async (read) => await read(tx),
    now,
  });
  const classifySource = await loadMonitoringClassifier(tx, organizationId);
  const fingerprint = monitoringFingerprint(contact);
  const eligibleSources = freshness.flatMap((source) => {
    const screening = screenings.find((row) => row.sourceId === source.source);
    return source.status === "fresh" &&
      source.edition !== null &&
      screening?.status === "possible-match" &&
      screening.editionId === source.edition.id &&
      screening.contactFingerprint === fingerprint
      ? [
          and(
            eq(sanctionsContactMatches.sourceId, source.source),
            eq(sanctionsContactMatches.editionId, source.edition.id),
          ),
        ]
      : [];
  });
  const rows =
    excluded || eligibleSources.length === 0
      ? []
      : await tx
          .select()
          .from(sanctionsContactMatches)
          .where(
            and(
              eq(sanctionsContactMatches.organizationId, organizationId),
              eq(sanctionsContactMatches.contactId, contactId),
              eq(sanctionsContactMatches.state, "active"),
              eq(sanctionsContactMatches.contactFingerprint, fingerprint),
              or(...eligibleSources),
              typeof afterSource === "string" && typeof afterEntry === "string"
                ? sql`(${sanctionsContactMatches.sourceId}, ${sanctionsContactMatches.sourceEntryId}) > (${afterSource}, ${afterEntry})`
                : undefined,
            ),
          )
          .orderBy(
            asc(sanctionsContactMatches.sourceId),
            asc(sanctionsContactMatches.sourceEntryId),
          )
          .limit(limit + 1);
  const matches = createCursorPage({
    rows: rows.map((row) =>
      Object.assign(row, {
        classification: classifySource(row.sourceId),
        reviewTarget: {
          source: isSanctionsSource(row.sourceId)
            ? row.sourceId
            : panic("Stored sanctions match has an unknown source"),
          sourceEntryId: row.sourceEntryId,
          expectedContactFingerprint: row.contactFingerprint,
          expectedEntryHash: row.entryHash,
        },
      }),
    ),
    limit,
    cursorForItem: (row) =>
      encodePaginationCursor([
        organizationId,
        contactId,
        row.sourceId,
        row.sourceEntryId,
      ]),
  });
  return Result.ok({
    contactId,
    contactMode: contact.sanctionsMonitoringMode,
    firmMode,
    matches,
    truncated: matches.nextCursor !== null,
    lists: freshness.map((source) => {
      const screening = screenings.find(
        (row) => row.sourceId === source.source,
      );
      const current =
        screening?.contactFingerprint === fingerprint &&
        screening.editionId === source.edition?.id &&
        source.status === "fresh";
      const status = (() => {
        if (excluded) {
          return "excluded";
        }
        return current ? screening.status : "unavailable";
      })();
      const excludedReason =
        firmMode === "disabled" ? "monitoring-disabled" : "contact-excluded";
      const screeningReason = current
        ? screening.reason
        : (source.reason ?? "pending-screening");
      return {
        source: source.source,
        classification: classifySource(source.source),
        status,
        reason: excluded ? excludedReason : screeningReason,
        freshness: source,
        checkedAt: screening?.checkedAt ?? null,
      };
    }),
  });
};

type MonitoringPageOptions = {
  organizationId: SafeId<"organization">;
  cursor?: string | undefined;
  limit?: number;
  now?: Date;
};

// Durable awareness feed only. Delivery and recipient selection are separate.
export const listOpenSanctionsMatches = async (
  tx: Transaction,
  {
    organizationId,
    cursor,
    limit = SANCTIONS_MONITORING_PAGE_SIZE,
    now = new Date(),
  }: MonitoringPageOptions,
) => {
  const position = cursor === undefined ? null : decodePaginationCursor(cursor);
  if (
    cursor !== undefined &&
    (position?.length !== 4 ||
      position.at(0) !== organizationId ||
      !isUuidPaginationCursorPart(position.at(1)) ||
      typeof position.at(2) !== "string" ||
      typeof position.at(3) !== "string")
  ) {
    return invalidCursor("contacts.sanctions.matches.list");
  }
  const contactId = position?.at(1);
  const sourceId = position?.at(2);
  const sourceEntryId = position?.at(3);
  const freshness = await readSanctionsFreshness({
    db: async (read) => await read(tx),
    now,
  });
  const freshEditions = freshness.flatMap((source) =>
    source.status === "fresh" && source.edition !== null
      ? [
          and(
            eq(sanctionsContactMatches.sourceId, source.source),
            eq(sanctionsContactMatches.editionId, source.edition.id),
          ),
        ]
      : [],
  );
  const rows = await tx
    .select({
      contactId: sanctionsContactMatches.contactId,
      source: sanctionsContactMatches.sourceId,
      sourceEntryId: sanctionsContactMatches.sourceEntryId,
      evidence: sanctionsContactMatches.match,
    })
    .from(sanctionsContactMatches)
    .innerJoin(
      contacts,
      and(
        eq(contacts.organizationId, sanctionsContactMatches.organizationId),
        eq(contacts.id, sanctionsContactMatches.contactId),
      ),
    )
    .innerJoin(
      sanctionsContactScreenings,
      and(
        eq(
          sanctionsContactScreenings.organizationId,
          sanctionsContactMatches.organizationId,
        ),
        eq(
          sanctionsContactScreenings.contactId,
          sanctionsContactMatches.contactId,
        ),
        eq(
          sanctionsContactScreenings.sourceId,
          sanctionsContactMatches.sourceId,
        ),
        eq(
          sanctionsContactScreenings.editionId,
          sanctionsContactMatches.editionId,
        ),
        eq(
          sanctionsContactScreenings.contactFingerprint,
          sanctionsContactMatches.contactFingerprint,
        ),
      ),
    )
    .leftJoin(
      organizationSettings,
      eq(
        organizationSettings.organizationId,
        sanctionsContactMatches.organizationId,
      ),
    )
    .leftJoin(
      sanctionsContactMarks,
      and(
        eq(
          sanctionsContactMarks.organizationId,
          sanctionsContactMatches.organizationId,
        ),
        eq(sanctionsContactMarks.contactId, sanctionsContactMatches.contactId),
      ),
    )
    .where(
      and(
        eq(sanctionsContactMatches.organizationId, organizationId),
        eq(sanctionsContactMatches.state, "active"),
        eq(sanctionsContactMatches.disposition, "needs-review"),
        eq(contacts.sanctionsMonitoringMode, "included"),
        or(
          isNull(organizationSettings.organizationId),
          eq(organizationSettings.sanctionsMonitoringMode, "enabled"),
        ),
        isNull(sanctionsContactMarks.contactId),
        freshEditions.length === 0 ? sql`false` : or(...freshEditions),
        typeof contactId === "string" &&
          typeof sourceId === "string" &&
          typeof sourceEntryId === "string"
          ? sql`(${sanctionsContactMatches.contactId}, ${sanctionsContactMatches.sourceId}, ${sanctionsContactMatches.sourceEntryId}) > (${contactId}::uuid, ${sourceId}, ${sourceEntryId})`
          : undefined,
      ),
    )
    .orderBy(
      asc(sanctionsContactMatches.contactId),
      asc(sanctionsContactMatches.sourceId),
      asc(sanctionsContactMatches.sourceEntryId),
    )
    .limit(limit + 1);
  const classifySource = await loadMonitoringClassifier(tx, organizationId);
  return Result.ok(
    createCursorPage({
      rows: rows.map((row) =>
        Object.assign(row, {
          classification: classifySource(row.source),
        }),
      ),
      limit,
      cursorForItem: (row) =>
        encodePaginationCursor([
          organizationId,
          row.contactId,
          row.source,
          row.sourceEntryId,
        ]),
    }),
  );
};

export const listSanctionsMonitoringEvents = async (
  tx: Transaction,
  {
    organizationId,
    cursor,
    limit = SANCTIONS_MONITORING_PAGE_SIZE,
  }: MonitoringPageOptions,
) => {
  const position = cursor === undefined ? null : decodePaginationCursor(cursor);
  if (
    cursor !== undefined &&
    (position?.length !== 3 ||
      position.at(0) !== organizationId ||
      parseDateTimePaginationCursorPart(position.at(1)) === null ||
      !isUuidPaginationCursorPart(position.at(2)))
  ) {
    return invalidCursor("contacts.sanctions.events.list");
  }
  const afterTime = parseDateTimePaginationCursorPart(position?.at(1));
  const afterId = position?.at(2);
  const rows = await tx
    .select({
      id: sanctionsScreeningEvents.id,
      contactId: sanctionsScreeningEvents.contactId,
      source: sanctionsScreeningEvents.sourceId,
      sourceEntryId: sanctionsScreeningEvents.sourceEntryId,
      type: sanctionsScreeningEvents.type,
      createdAt: sanctionsScreeningEvents.createdAt,
    })
    .from(sanctionsScreeningEvents)
    .innerJoin(
      contacts,
      and(
        eq(contacts.organizationId, sanctionsScreeningEvents.organizationId),
        eq(contacts.id, sanctionsScreeningEvents.contactId),
      ),
    )
    .leftJoin(
      organizationSettings,
      eq(
        organizationSettings.organizationId,
        sanctionsScreeningEvents.organizationId,
      ),
    )
    .where(
      and(
        eq(sanctionsScreeningEvents.organizationId, organizationId),
        inArray(sanctionsScreeningEvents.type, [
          ...SANCTIONS_NOTIFICATION_EVENT_TYPES,
        ]),
        eq(contacts.sanctionsMonitoringMode, "included"),
        or(
          isNull(organizationSettings.organizationId),
          eq(organizationSettings.sanctionsMonitoringMode, "enabled"),
        ),
        typeof afterId === "string" && afterTime !== null
          ? sql`(${sanctionsScreeningEvents.createdAt}, ${sanctionsScreeningEvents.id}) > (${afterTime.toISOString()}::timestamptz, ${afterId}::uuid)`
          : undefined,
      ),
    )
    .orderBy(
      asc(sanctionsScreeningEvents.createdAt),
      asc(sanctionsScreeningEvents.id),
    )
    .limit(limit + 1);
  return Result.ok(
    createCursorPage({
      rows,
      limit,
      cursorForItem: (row) =>
        encodePaginationCursor([
          organizationId,
          row.createdAt.toISOString(),
          row.id,
        ]),
    }),
  );
};
