import { Result } from "better-result";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

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
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";

export const SANCTIONS_MONITORING_PAGE_SIZE = 100;
const MATCHES_PER_LIST = 1000;

export const readContactSanctions = async (
  tx: Transaction,
  {
    organizationId,
    contactId,
    now = new Date(),
  }: {
    organizationId: SafeId<"organization">;
    contactId: SafeId<"contact">;
    now?: Date;
  },
) => {
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
  const matches = excluded
    ? []
    : await tx
        .select()
        .from(sanctionsContactMatches)
        .where(
          and(
            eq(sanctionsContactMatches.organizationId, organizationId),
            eq(sanctionsContactMatches.contactId, contactId),
            eq(sanctionsContactMatches.state, "active"),
          ),
        )
        .limit(MATCHES_PER_LIST * sanctionsSourceIds().length);
  const db = async <T>(read: (handle: Transaction) => Promise<T>) =>
    await read(tx);
  const freshness = await readSanctionsFreshness({ db, now });
  const practiceJurisdictions = (
    await loadPracticeJurisdictions({ scopedDb: db, organizationId })
  )
    .map((row) => row.countryCode)
    .filter(isCountryCode);
  const fingerprint = monitoringFingerprint(contact);
  return Result.ok({
    contactId,
    contactMode: contact.sanctionsMonitoringMode,
    firmMode,
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
        classification: classifySanctionsIssuer(
          SANCTIONS_SOURCES[source.source].issuer,
          practiceJurisdictions,
        ),
        status,
        reason: excluded ? excludedReason : screeningReason,
        freshness: source,
        checkedAt: screening?.checkedAt ?? null,
        matches:
          status === "possible-match"
            ? matches.filter(
                (row) =>
                  row.sourceId === source.source &&
                  row.editionId === source.edition?.id &&
                  row.contactFingerprint === fingerprint,
              )
            : [],
      };
    }),
  });
};

type MonitoringPageOptions = {
  organizationId: SafeId<"organization">;
  cursor?: string;
  limit?: number;
  now?: Date;
};

const invalidCursor = () =>
  Result.err(
    new HandlerError({
      status: 400,
      code: "invalid_cursor",
      message:
        "Invalid sanctions cursor; call contacts.sanctions.matches.list without cursor to restart",
    }),
  );

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
    (position === null ||
      position.length !== 4 ||
      position.at(0) !== organizationId ||
      !isUuidPaginationCursorPart(position.at(1)) ||
      typeof position.at(2) !== "string" ||
      typeof position.at(3) !== "string")
  ) {
    return invalidCursor();
  }
  const [_, contactId, sourceId, sourceEntryId] =
    position === null ? [] : position;
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
  return Result.ok(
    createCursorPage({
      rows,
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

// Durable awareness feed only. Delivery and recipient selection are separate.
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
    (position === null ||
      position.length !== 2 ||
      position.at(0) !== organizationId ||
      !isUuidPaginationCursorPart(position.at(1)))
  ) {
    return invalidCursor();
  }
  const afterId = position?.at(1);
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
        typeof afterId === "string"
          ? gt(sanctionsScreeningEvents.id, sql`${afterId}::uuid`)
          : undefined,
      ),
    )
    .orderBy(asc(sanctionsScreeningEvents.id))
    .limit(limit + 1);
  return Result.ok(
    createCursorPage({
      rows,
      limit,
      cursorForItem: (row) => encodePaginationCursor([organizationId, row.id]),
    }),
  );
};
