import { and, eq, inArray, sql } from "drizzle-orm";

import {
  getEventLabel,
  parseInfoSoudDate,
  parseInfoSoudDateTime,
} from "@stll/infosoud";
import type { CaseEvent, CaseSearchResult, HearingEvent } from "@stll/infosoud";

import type { Transaction } from "@/api/db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { AgendaItemKind } from "@/api/lib/entity-constants";
import { AGENDA_ITEM_KIND, TASK_STATUS } from "@/api/lib/entity-constants";
import { LIMITS } from "@/api/lib/limits";

type InfoSoudAgendaItem = {
  agendaKind: AgendaItemKind;
  allDay: boolean;
  externalData: Record<string, unknown>;
  externalICalUid: string;
  externalId: string;
  location: string | null;
  name: string;
  occurredAt: Date | null;
  startAt: Date | null;
  status: string;
};

type CaseMark = {
  bcVec: number;
  cisloSenatu: number;
  druhVeci: string;
  organizace: string;
  rocnik: number;
};

type ImportInfoSoudAgendaItemsOptions = {
  agendaItems: InfoSoudAgendaItem[];
  actorUserId: string | null;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

type ImportInfoSoudAgendaItemsResult =
  | {
      ok: true;
      created: number;
      skipped: number;
      total: number;
    }
  | {
      ok: false;
      created: 0;
      skipped: number;
      total: number;
      message: string;
      status: 400;
    };

export const INFO_SOUD_EXTERNAL_SOURCE = "infosoud" as const;
export const INFO_SOUD_TIME_ZONE = "Europe/Prague";

export const buildInfoSoudAgendaItems = (
  caseResult: CaseSearchResult,
  hearings: HearingEvent[],
): InfoSoudAgendaItem[] => [
  ...caseResult.udalosti.map((event) =>
    buildEventAgendaItem(caseResult, event),
  ),
  ...hearings.map((hearing) => buildHearingAgendaItem(caseResult, hearing)),
];

export const importInfoSoudAgendaItems = async ({
  actorUserId,
  agendaItems,
  tx,
  workspaceId,
}: ImportInfoSoudAgendaItemsOptions): Promise<ImportInfoSoudAgendaItemsResult> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);

  const externalIds = agendaItems.map((item) => item.externalId);
  const existingRows =
    externalIds.length > 0
      ? await tx
          .select({ externalId: entities.externalId })
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              eq(entities.externalSource, INFO_SOUD_EXTERNAL_SOURCE),
              inArray(entities.externalId, externalIds),
            ),
          )
      : [];
  const existingExternalIds = new Set(
    existingRows
      .map((row) => row.externalId)
      .filter((externalId) => externalId !== null),
  );
  const newItems = agendaItems.filter(
    (item) => !existingExternalIds.has(item.externalId),
  );

  const totalEntities = await tx.$count(
    entities,
    eq(entities.workspaceId, workspaceId),
  );
  if (totalEntities + newItems.length > LIMITS.entitiesCount) {
    return {
      created: 0,
      ok: false,
      skipped: existingExternalIds.size,
      status: 400,
      total: agendaItems.length,
      message: "Entities limit reached",
    };
  }

  if (newItems.length === 0) {
    return {
      created: 0,
      ok: true,
      skipped: agendaItems.length,
      total: agendaItems.length,
    };
  }

  const values = newItems.map((item) => ({
    id: createSafeId<"entity">(),
    workspaceId,
    kind: "task" as const,
    name: item.name,
    createdBy: actorUserId,
    agendaKind: item.agendaKind,
    status: item.status,
    priority: "none",
    startAt: item.startAt,
    occurredAt: item.occurredAt,
    allDay: item.allDay,
    timeZone: INFO_SOUD_TIME_ZONE,
    location: item.location,
    agendaSource: INFO_SOUD_EXTERNAL_SOURCE,
    externalSource: INFO_SOUD_EXTERNAL_SOURCE,
    externalId: item.externalId,
    externalICalUid: item.externalICalUid,
    externalData: item.externalData,
    readOnly: true,
  }));

  const inserted = await tx
    .insert(entities)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: entities.id });

  if (inserted.length > 0) {
    const versions = inserted.map(({ id }) => ({
      id: createSafeId<"entityVersion">(),
      workspaceId,
      entityId: id,
      versionNumber: 1,
      createdBy: actorUserId,
    }));

    await tx.insert(entityVersions).values(versions);
    const currentVersionCases = versions.map(
      (version) => sql`when ${version.entityId} then ${version.id}`,
    );

    await tx
      .update(entities)
      .set({
        currentVersionId: sql`case ${entities.id} ${sql.join(currentVersionCases, sql` `)} else ${entities.currentVersionId} end`,
      })
      .where(
        inArray(
          entities.id,
          versions.map((version) => version.entityId),
        ),
      );

    await tx
      .update(workspaces)
      .set({ lastActivityAt: new Date() })
      .where(eq(workspaces.id, workspaceId));
  }

  return {
    created: inserted.length,
    ok: true,
    skipped: agendaItems.length - inserted.length,
    total: agendaItems.length,
  };
};

const formatCaseMark = ({
  bcVec,
  cisloSenatu,
  druhVeci,
  organizace,
  rocnik,
}: CaseMark): string =>
  `${cisloSenatu} ${druhVeci} ${bcVec}/${rocnik}${organizace ? ` ${organizace}` : ""}`;

const toDateFromUnixMs = (unixMs: number | null): Date | null =>
  unixMs === null ? null : new Date(unixMs);

const toStableExternalId = (kind: string, value: unknown): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(value));
  return `${INFO_SOUD_EXTERNAL_SOURCE}:${kind}:${hasher.digest("hex").slice(0, 40)}`;
};

const toICalUid = (externalId: string): string =>
  `${externalId}@infosoud.stella`;

const getStatus = (
  date: Date | null,
  cancelled: boolean | null | undefined,
): string => {
  if (cancelled) {
    return TASK_STATUS.CANCELLED;
  }
  if (date === null) {
    return TASK_STATUS.DONE;
  }
  return date.getTime() <= Date.now() ? TASK_STATUS.DONE : TASK_STATUS.OPEN;
};

const buildEventAgendaItem = (
  caseResult: CaseSearchResult,
  event: CaseEvent,
): InfoSoudAgendaItem => {
  const eventDate = toDateFromUnixMs(parseInfoSoudDate(event.datum).unixMs);
  const caseMark = formatCaseMark(event.znackaId);
  const label = getEventLabel(event.udalost) ?? event.udalost;
  const externalId = toStableExternalId("event", {
    caseMark,
    court: event.znackaId.organizace,
    date: event.datum,
    order: event.poradi,
    type: event.udalost,
  });

  return {
    agendaKind: AGENDA_ITEM_KIND.EVENT,
    allDay: true,
    externalData: {
      case: {
        caseMark: formatCaseMark({
          bcVec: caseResult.bcVec,
          cisloSenatu: caseResult.cislo,
          druhVeci: caseResult.druh,
          organizace: "",
          rocnik: caseResult.rocnik,
        }),
        court: caseResult.organizace,
        parentCourt: caseResult.nadrizenaOrganizace,
      },
      event: {
        cancelled: event.zruseno,
        date: event.datum,
        label,
        order: event.poradi,
        type: event.udalost,
      },
      source: INFO_SOUD_EXTERNAL_SOURCE,
    },
    externalICalUid: toICalUid(externalId),
    externalId,
    location: null,
    name: `${label}: ${caseMark}`,
    occurredAt: eventDate,
    startAt: null,
    status: getStatus(eventDate, event.zruseno),
  };
};

const buildHearingAgendaItem = (
  caseResult: CaseSearchResult,
  hearing: HearingEvent,
): InfoSoudAgendaItem => {
  const scheduledRaw = `${hearing.datum} ${hearing.cas}`.trim();
  const scheduled = parseInfoSoudDateTime(scheduledRaw);
  const fallbackDate = parseInfoSoudDate(hearing.datum);
  const startAt = toDateFromUnixMs(scheduled.unixMs ?? fallbackDate.unixMs);
  const caseMark = formatCaseMark({
    bcVec: hearing.bcVec ?? caseResult.bcVec,
    cisloSenatu: hearing.cislo ?? caseResult.cislo,
    druhVeci: hearing.druh ?? caseResult.druh,
    organizace: "",
    rocnik: hearing.rocnik ?? caseResult.rocnik,
  });
  const label = hearing.druhJednani ?? "Jednání";
  const externalId = toStableExternalId("hearing", {
    caseMark,
    date: hearing.datum,
    room: hearing.jednaciSin,
    time: hearing.cas,
    type: hearing.druhJednani,
  });

  return {
    agendaKind: AGENDA_ITEM_KIND.HEARING,
    allDay: scheduled.unixMs === null,
    externalData: {
      case: {
        caseMark: formatCaseMark({
          bcVec: caseResult.bcVec,
          cisloSenatu: caseResult.cislo,
          druhVeci: caseResult.druh,
          organizace: "",
          rocnik: caseResult.rocnik,
        }),
        court: caseResult.organizace,
        parentCourt: caseResult.nadrizenaOrganizace,
      },
      hearing: {
        cancelled: hearing.jednaniZruseno,
        date: hearing.datum,
        judge: hearing.resitel,
        private: hearing.neverejneJednani,
        result: hearing.vysledek,
        room: hearing.jednaciSin,
        subject: hearing.predmetJednani,
        time: hearing.cas,
        type: hearing.druhJednani,
      },
      source: INFO_SOUD_EXTERNAL_SOURCE,
    },
    externalICalUid: toICalUid(externalId),
    externalId,
    location: hearing.jednaciSin,
    name: `${label}: ${caseMark}`,
    occurredAt: null,
    startAt,
    status: getStatus(startAt, hearing.jednaniZruseno),
  };
};
