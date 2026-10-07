import { panic } from "better-result";
import { expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { formatSpisZnCanonical } from "@stll/infosoud";
import type { CaseSearchResultWithHearings } from "@stll/infosoud";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import type { infoSoudTrackedCases } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { buildInfoSoudAgendaItems } from "@/api/lib/infosoud/agenda-import";
import type { importInfoSoudAgendaItems } from "@/api/lib/infosoud/agenda-import";
import { LIMITS } from "@/api/lib/limits";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  createSyncInfoSoudTrackedCasesTask,
  INFO_SOUD_SYNC_FAILURE_REASONS,
  InfoSoudSyncIncomplete,
} from "./infosoud";

const lookup = {
  case: {
    cislo: 1,
    druh: "C",
    rocnik: 2026,
    bcVec: 1,
    nadrizenaOrganizace: null,
    organizace: "synthetic-court",
    typOrganizace: "OS",
    stav: null,
    stavDatum: null,
    napad: null,
    udalosti: [],
    navazneVeci: [],
    platneK: null,
  },
  hearings: {
    nadrizenaOrganizace: null,
    organizace: "synthetic-court",
    jednaciSin: null,
    datum: null,
    typ: "SPZN",
    cislo: 1,
    bcVec: 1,
    druh: "C",
    rocnik: 2026,
    udalosti: [],
    platneK: null,
  },
} satisfies CaseSearchResultWithHearings;

const oversizedLookup = {
  case: {
    ...lookup.case,
    udalosti: Array.from(
      { length: LIMITS.infoSoudAgendaImportItemsMax + 1 },
      (_, index) => ({
        udalostId: index,
        udalost: "synthetic-event",
        poradi: index,
        datum: "/Date(0)/",
        zruseno: false,
        znackaId: {
          cisloSenatu: 1,
          druhVeci: "C",
          bcVec: 1,
          rocnik: 2026,
          organizace: "synthetic-court",
        },
        jednani: [],
      }),
    ),
  },
  hearings: lookup.hearings,
} satisfies CaseSearchResultWithHearings;

const successfulImport = {
  ok: true,
  created: 0,
  skipped: 0,
  total: 0,
} as const;
const refusedImport = {
  ok: false,
  created: 0,
  skipped: 0,
  total: 0,
  message: "Entities limit reached",
  status: 400,
} as const;

const failureCases = {
  "agenda-limit": {
    persistedError: "InfoSoudAgendaImportLimit",
    lookup: async () => oversizedLookup,
    importAgenda: async () => successfulImport,
  },
  "import-refused": {
    persistedError: "InfoSoudAgendaImportFailed",
    lookup: async () => lookup,
    importAgenda: async () => refusedImport,
  },
  "case-failed": {
    persistedError: "TypeError",
    lookup: async (): Promise<CaseSearchResultWithHearings> => {
      throw new TypeError("Synthetic case lookup failure");
    },
    importAgenda: async () => successfulImport,
  },
} satisfies Record<
  (typeof INFO_SOUD_SYNC_FAILURE_REASONS)[number],
  {
    persistedError: string;
    lookup: () => Promise<CaseSearchResultWithHearings>;
    importAgenda: () => Promise<typeof successfulImport | typeof refusedImport>;
  }
>;

const fixture = (count = 3) => {
  const rows: (typeof infoSoudTrackedCases.$inferSelect)[] = Array.from(
    { length: count },
    (_, index) =>
      ({
        id: toSafeId<"infoSoudTrackedCase">(`synthetic-case-${index}`),
        workspaceId: toSafeId<"workspace">("synthetic-matter"),
        courtCode: "synthetic-court",
        spisZn: `1 C ${index + 1}/2026`,
        enabled: true,
        createdBy: null,
        lastSyncAttemptAt: null,
        lastSyncedAt: null,
        lastSyncError: null,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      }) satisfies typeof infoSoudTrackedCases.$inferSelect,
  );
  const pages = [rows, []];
  const writes: {
    lastSyncAttemptAt: Date;
    lastSyncError: string | null;
    lastSyncedAt?: Date;
  }[] = [];
  const update = () => ({
    set: (values: (typeof writes)[number]) => ({
      where: (condition: SQL) => {
        const statement = new PgDialect().sqlToQuery(condition);
        const row = rows.find(({ id }) => statement.params.includes(id));
        if (row === undefined) {
          panic("Expected a tracked case update");
        }
        const fenced = statement.sql.includes('"last_sync_attempt_at"');
        if (fenced) {
          expect(statement.sql).toMatch(
            /"last_sync_attempt_at" is null\)+ or \(+"infosoud_tracked_cases"\."last_sync_attempt_at" < \$\d+/u,
          );
          expect(statement.params).toContain(
            values.lastSyncAttemptAt.toISOString(),
          );
        }
        const affected =
          !fenced ||
          row.lastSyncAttemptAt === null ||
          row.lastSyncAttemptAt < values.lastSyncAttemptAt;
        if (affected) {
          Object.assign(row, values);
          writes.push(values);
        }
        return {
          returning: async () => (affected ? [{ id: row.id }] : []),
        };
      },
    }),
  });
  const tx = asTestRaw<Transaction>({
    update,
    query: {
      workspaces: {
        findFirst: async () => ({
          organizationId: toSafeId<"organization">("synthetic-org"),
        }),
      },
    },
  });
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: async () => pages.shift() ?? [],
  };
  const controller = new AbortController();
  const warn = mock();
  const info = mock();
  const context = asTestRaw<SchedulerTaskContext>({
    dueAt: DueSlot.of({
      nextRunAt: new Date("2026-01-01T03:00:00.000Z"),
      lockedAt: new Date("2026-01-01T04:00:00.000Z"),
    }),
    db: {
      select: () => query,
      update,
      transaction: async (callback: (db: Transaction) => Promise<unknown>) =>
        await callback(tx),
    },
    logger: { warn, info },
    signal: controller.signal,
  });
  return { context, controller, rows, pages, writes, warn, info };
};

const stampCases = {
  success: {
    lookup: async () => lookup,
    importAgenda: async () => successfulImport,
  },
  ...failureCases,
};

test.each(
  Object.entries(stampCases).flatMap(([path, behavior]) =>
    [0, 1].map((offset) => ({ path, behavior, offset })),
  ),
)(
  "$path preserves an attempt at or after the claim instant ($offset)",
  async ({ behavior, offset }) => {
    const { context, rows, writes, warn, info } = fixture(1);
    const row = rows.at(0);
    if (row === undefined) {
      panic("Expected a tracked case fixture");
    }
    const newer = new Date(context.dueAt.claimedAtDate().getTime() + offset);
    const task = createSyncInfoSoudTrackedCasesTask({
      searchCaseWithHearings: async () => {
        row.lastSyncAttemptAt = newer;
        row.lastSyncedAt = newer;
        row.lastSyncError = "Synthetic newer writer";
        return await behavior.lookup();
      },
      importAgendaItems: behavior.importAgenda,
    });
    expect((await task(context)).isOk()).toBe(true);
    expect(writes).toEqual([]);
    expect(row).toMatchObject({
      lastSyncAttemptAt: newer,
      lastSyncedAt: newer,
      lastSyncError: "Synthetic newer writer",
    });
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("scheduler.infosoud_sync_superseded", {
      "infosoud.failed": 0,
      "infosoud.synced": 0,
      "infosoud.superseded": 1,
      "infosoud.total": 1,
    });
  },
);

test("superseded rows do not inflate success or failure counts in a mixed page", async () => {
  const { context, rows, warn, info } = fixture();
  let visited = 0;
  const task = createSyncInfoSoudTrackedCasesTask({
    searchCaseWithHearings: async () => {
      visited += 1;
      if (visited === 1) {
        const row = rows.at(0);
        if (row === undefined) {
          panic("Expected a tracked case fixture");
        }
        row.lastSyncAttemptAt = new Date(
          context.dueAt.claimedAtDate().getTime() + 1,
        );
        return await failureCases["case-failed"].lookup();
      }
      return lookup;
    },
    importAgendaItems: async () =>
      visited === 2 ? refusedImport : successfulImport,
  });
  const result = await task(context);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.cause).toMatchObject({
      failed: 1,
      synced: 1,
      superseded: 1,
      total: 3,
    });
  }
  const counts = {
    "infosoud.failed": 1,
    "infosoud.synced": 1,
    "infosoud.superseded": 1,
    "infosoud.total": 3,
  };
  expect(info).toHaveBeenCalledWith(
    "scheduler.infosoud_sync_superseded",
    counts,
  );
  expect(warn).toHaveBeenCalledWith("scheduler.infosoud_sync_incomplete", {
    ...counts,
    "infosoud.failure.agenda-limit": 0,
    "infosoud.failure.import-refused": 1,
    "infosoud.failure.case-failed": 0,
  });
});

for (const reason of INFO_SOUD_SYNC_FAILURE_REASONS) {
  test.each([0, 1, 2])(
    `${reason} at position %i reports a failed sync while other cases finish`,
    async (failureIndex) => {
      const { context, rows, writes, warn, info } = fixture();
      const failure = failureCases[reason];
      const visited: string[] = [];
      const importAgendaItems = mock(
        async ({
          workspaceId,
          agendaItems,
        }: Parameters<typeof importInfoSoudAgendaItems>[0]) => {
          expect(rows.at(0)?.workspaceId).toBe(workspaceId);
          expect(agendaItems).toEqual([]);
          return visited.length - 1 === failureIndex
            ? await failure.importAgenda()
            : successfulImport;
        },
      );
      const task = createSyncInfoSoudTrackedCasesTask({
        searchCaseWithHearings: async ({ spisZn }) => {
          visited.push(
            typeof spisZn === "string" ? spisZn : formatSpisZnCanonical(spisZn),
          );
          return visited.length - 1 === failureIndex
            ? await failure.lookup()
            : lookup;
        },
        importAgendaItems,
      });
      const outcome = await task(context);
      expect(visited).toEqual(rows.map((row) => row.spisZn));
      expect(writes.map((write) => write.lastSyncError)).toEqual(
        rows.map((_, index) =>
          index === failureIndex ? failure.persistedError : null,
        ),
      );
      expect(importAgendaItems).toHaveBeenCalledTimes(
        reason === "import-refused" ? 3 : 2,
      );
      expect(
        writes.every(
          (write) =>
            write.lastSyncAttemptAt.getTime() ===
            context.dueAt.claimedAtDate().getTime(),
        ),
      ).toBe(true);
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(InfoSoudSyncIncomplete.is(outcome.error.cause)).toBe(true);
      }
      expect(info).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("scheduler.infosoud_sync_incomplete", {
        "infosoud.failed": 1,
        "infosoud.synced": 2,
        "infosoud.superseded": 0,
        "infosoud.total": 3,
        ...Object.fromEntries(
          INFO_SOUD_SYNC_FAILURE_REASONS.map((key) => [
            `infosoud.failure.${key}`,
            key === reason ? 1 : 0,
          ]),
        ),
      });
    },
  );
}

test("every failure reason stays visible when no case syncs", async () => {
  const { context, writes, warn } = fixture();
  let position = 0;
  let currentReason: (typeof INFO_SOUD_SYNC_FAILURE_REASONS)[number] =
    "case-failed";
  const task = createSyncInfoSoudTrackedCasesTask({
    searchCaseWithHearings: async () => {
      const nextReason = INFO_SOUD_SYNC_FAILURE_REASONS.at(position++);
      if (nextReason === undefined) {
        return panic("Expected one lookup per failure reason");
      }
      currentReason = nextReason;
      return await failureCases[currentReason].lookup();
    },
    importAgendaItems: async () =>
      await failureCases[currentReason].importAgenda(),
  });
  const outcome = await task(context);
  expect(writes.map((write) => write.lastSyncError)).toEqual(
    INFO_SOUD_SYNC_FAILURE_REASONS.map(
      (reason) => failureCases[reason].persistedError,
    ),
  );
  expect(outcome.isErr()).toBe(true);
  if (outcome.isErr()) {
    expect(outcome.error.cause).toMatchObject({
      failed: 3,
      synced: 0,
      total: 3,
      reasons: { "agenda-limit": 1, "import-refused": 1, "case-failed": 1 },
    });
  }
  expect(warn).toHaveBeenCalledTimes(1);
});

test("failures accumulate across pages without preventing later cases from syncing", async () => {
  const { context, rows, pages, writes, warn } = fixture(6);
  pages.splice(
    0,
    pages.length,
    rows.slice(0, 2),
    rows.slice(2, 4),
    rows.slice(4),
    [],
  );
  let imported = 0;
  const task = createSyncInfoSoudTrackedCasesTask({
    searchCaseWithHearings: async () => lookup,
    importAgendaItems: async () => {
      imported += 1;
      return imported % 2 === 0 ? refusedImport : successfulImport;
    },
  });
  const outcome = await task(context);
  expect(imported).toBe(6);
  expect(writes.filter((write) => write.lastSyncError === null)).toHaveLength(
    3,
  );
  expect(outcome.isErr()).toBe(true);
  if (outcome.isErr()) {
    expect(outcome.error.cause).toMatchObject({
      failed: 3,
      synced: 3,
      total: 6,
      reasons: { "agenda-limit": 0, "import-refused": 3, "case-failed": 0 },
    });
  }
  expect(warn).toHaveBeenCalledTimes(1);
});

test("an import exception remains a reported case failure", async () => {
  const { context, writes, warn } = fixture(1);
  const task = createSyncInfoSoudTrackedCasesTask({
    searchCaseWithHearings: async () => lookup,
    importAgendaItems: async () => {
      throw new TypeError("Synthetic import failure");
    },
  });
  const outcome = await task(context);
  expect(outcome.isErr()).toBe(true);
  expect(writes.map((write) => write.lastSyncError)).toEqual(["TypeError"]);
  expect(warn).toHaveBeenCalledWith("scheduler.infosoud_sync_incomplete", {
    "infosoud.failed": 1,
    "infosoud.synced": 0,
    "infosoud.total": 1,
    "infosoud.superseded": 0,
    "infosoud.failure.agenda-limit": 0,
    "infosoud.failure.import-refused": 0,
    "infosoud.failure.case-failed": 1,
  });
});

test.each([0, 3])(
  "a complete sync of %i cases reports success",
  async (count) => {
    const { context, writes, warn, info } = fixture(count);
    const task = createSyncInfoSoudTrackedCasesTask({
      searchCaseWithHearings: async () => lookup,
      importAgendaItems: async () => successfulImport,
    });
    expect((await task(context)).isOk()).toBe(true);
    expect(writes).toHaveLength(count);
    expect(writes.every((write) => write.lastSyncError === null)).toBe(true);
    expect(
      writes.every(
        (write) =>
          write.lastSyncedAt?.getTime() ===
          context.dueAt.claimedAtDate().getTime(),
      ),
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("scheduler.infosoud_sync_completed", {
      "infosoud.failed": 0,
      "infosoud.synced": count,
      "infosoud.superseded": 0,
      "infosoud.total": count,
    });
  },
);

test("cancellation during lookup does not stamp a case or report completion", async () => {
  const { context, controller, writes, warn, info } = fixture();
  const task = createSyncInfoSoudTrackedCasesTask({
    searchCaseWithHearings: async () => {
      controller.abort();
      return lookup;
    },
    importAgendaItems: async () => successfulImport,
  });
  expect(await rejectionOf(task(context))).toHaveProperty(
    "message",
    "SchedulerAborted",
  );
  expect(writes).toEqual([]);
  expect(warn).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});

test("a cancelled lookup rejection is handled as cancellation", async () => {
  const { context, controller, writes, warn, info } = fixture();
  const task = createSyncInfoSoudTrackedCasesTask({
    searchCaseWithHearings: async () => {
      controller.abort();
      throw new TypeError("Synthetic cancelled lookup");
    },
    importAgendaItems: async () => successfulImport,
  });
  expect(await rejectionOf(task(context))).toHaveProperty(
    "message",
    "SchedulerAborted",
  );
  expect(writes).toEqual([]);
  expect(warn).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});

test("an already cancelled run does not start a lookup", async () => {
  const { context, controller, writes, warn, info } = fixture();
  controller.abort();
  const searchCaseWithHearings = mock(async () => lookup);
  const task = createSyncInfoSoudTrackedCasesTask({
    searchCaseWithHearings,
    importAgendaItems: async () => successfulImport,
  });
  expect(await rejectionOf(task(context))).toHaveProperty(
    "message",
    "SchedulerAborted",
  );
  expect(searchCaseWithHearings).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
  expect(warn).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});

test("the agenda-limit fixture exceeds the actual import bound", () => {
  expect(
    buildInfoSoudAgendaItems(
      oversizedLookup.case,
      oversizedLookup.hearings.udalosti,
    ),
  ).toHaveLength(LIMITS.infoSoudAgendaImportItemsMax + 1);
});
