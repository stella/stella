import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { SANCTIONS_SOURCES, type SanctionsSource } from "@stll/sanctions";
import { sha256Hex } from "@stll/sha256/bun";

import { organization } from "@/api/db/auth-schema";
import {
  contacts,
  sanctionsContactScreenings,
  sanctionsEditions,
  sanctionsSources,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import type { SANCTIONS_SCREENING_STATUSES } from "@/api/lib/lists/sanctions/monitoring-vocabulary";
import {
  SANCTIONS_SOURCE_CONFIG,
  sanctionsSourceIds,
} from "@/api/lib/lists/sanctions/source-config";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import {
  installRecordingLogger,
  type RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { runDataInvariants } from "./invariant";
import {
  SANCTIONS_INCOMPLETE_SHARE_MAX,
  sanctionsListsInvariant,
  sanctionsScreeningCompletenessInvariant,
} from "./sanctions";

const TIMEOUT = 120_000;
const NOW = new Date("2026-10-17T09:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const ORGANIZATION_ID = toSafeId<"organization">("invariant-org");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let lines: Record<string, unknown>[];
let logs: RecordingLogger;

/** One edition with entries and one without, per list. */
const editions = new Map<
  SanctionsSource,
  {
    full: SafeId<"sanctionsEdition">;
    empty: SafeId<"sanctionsEdition">;
  }
>();

const editionsOf = (source: SanctionsSource) =>
  editions.get(source) ?? panic(`No seeded edition for ${source}`);

const readDb = () =>
  executeRowsScopedDb(
    async (run) => await db.transaction(async (tx) => await run(tx)),
  );

const invariants = () => [
  sanctionsListsInvariant({
    readFreshness: async (now) =>
      await readSanctionsFreshness({ db: readDb(), now }),
  }),
  sanctionsScreeningCompletenessInvariant({ db: readDb() }),
];

const run = async () =>
  await runDataInvariants(invariants(), {
    now: NOW,
    signal: new AbortController().signal,
  });

const findingsOf = (
  reports: Awaited<ReturnType<typeof run>>,
  index: number,
) => {
  const outcome = reports.at(index)?.outcome;
  return outcome?.status === "violated" ? outcome.findings : [];
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(organization).values({
    id: ORGANIZATION_ID,
    name: "Invariant test",
    slug: "invariant-test",
    createdAt: NOW,
  });
  await db.insert(sanctionsSources).values(
    sanctionsSourceIds().map((id) => ({
      id,
      issuer: SANCTIONS_SOURCES[id].issuer,
      markerUrl: "https://example.test/list",
    })),
  );
  for (const source of sanctionsSourceIds()) {
    const full = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
    const empty = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
    await db.insert(sanctionsEditions).values(
      [
        { id: full, entryCount: 120 },
        { id: empty, entryCount: 0 },
      ].map(({ id, entryCount }) => ({
        id,
        sourceId: source,
        markerKey: sha256Hex(id),
        contentHash: sha256Hex(`${id}:content`),
        publishedAt: "2026-10-16",
        state: "ready" as const,
        entryCount,
      })),
    );
    editions.set(source, { full, empty });
  }
}, TIMEOUT);

afterAll(async () => {
  await client.close();
});

// Every test starts from healthy lists and no screenings, then replays the
// one failing state it is about.
beforeEach(async () => {
  lines = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(JSON.parse(line));
  });
  logs = installRecordingLogger();
  for (const source of sanctionsSourceIds()) {
    await db
      .update(sanctionsSources)
      .set({
        activeEditionId: editionsOf(source).full,
        lastSuccessfulVerifiedAt: new Date(NOW.getTime() - HOUR_MS),
      })
      .where(eq(sanctionsSources.id, source));
  }
});

afterEach(async () => {
  resetMetricLineSinkForTesting();
  logs.restore();
  await db
    .delete(sanctionsContactScreenings)
    .where(eq(sanctionsContactScreenings.organizationId, ORGANIZATION_ID));
  await db.delete(contacts).where(eq(contacts.organizationId, ORGANIZATION_ID));
});

type StoredScreeningStatus = (typeof SANCTIONS_SCREENING_STATUSES)[number];

type ScreeningsOptions = {
  source: SanctionsSource;
  total: number;
  incomplete: number;
  excluded?: number;
};

/** The first `incomplete` rows are incomplete, the next `excluded` excluded. */
const statusAt = (
  index: number,
  { incomplete, excluded = 0 }: ScreeningsOptions,
): StoredScreeningStatus => {
  if (index < incomplete) {
    return "incomplete";
  }
  return index < incomplete + excluded ? "excluded" : "clear";
};

const seedScreenings = async (options: ScreeningsOptions) => {
  const { source, total } = options;
  const rows = await db
    .insert(contacts)
    .values(
      Array.from({ length: total }, (_, index) => ({
        organizationId: ORGANIZATION_ID,
        type: "person" as const,
        displayName: `Synthetic Person ${source} ${index}`,
      })),
    )
    .returning({ id: contacts.id });
  await db.insert(sanctionsContactScreenings).values(
    rows.map(({ id }, index) => ({
      organizationId: ORGANIZATION_ID,
      contactId: id,
      sourceId: source,
      editionId: editionsOf(source).full,
      status: statusAt(index, options),
      contactFingerprint: sha256Hex(id),
      checkedAt: NOW,
    })),
  );
};

test(
  "healthy lists and screenings hold and emit healthy gauges",
  async () => {
    await seedScreenings({ source: "eu", total: 20, incomplete: 0 });

    const reports = await run();

    expect(reports.map(({ outcome }) => outcome.status)).toEqual([
      "held",
      "held",
    ]);
    expect(lines.map((line) => line["DataInvariantUnhealthy"])).toEqual([0, 0]);
  },
  TIMEOUT,
);

test(
  "a list that never loaded, one loaded empty and one gone stale each fire",
  async () => {
    await db
      .update(sanctionsSources)
      .set({ activeEditionId: null, lastSuccessfulVerifiedAt: null })
      .where(eq(sanctionsSources.id, "eu"));
    await db
      .update(sanctionsSources)
      .set({ activeEditionId: editionsOf("un").empty })
      .where(eq(sanctionsSources.id, "un"));
    const staleHours = SANCTIONS_SOURCE_CONFIG.uk.freshnessMs / HOUR_MS + 1;
    await db
      .update(sanctionsSources)
      .set({
        lastSuccessfulVerifiedAt: new Date(
          NOW.getTime() - staleHours * HOUR_MS,
        ),
      })
      .where(eq(sanctionsSources.id, "uk"));

    const reports = await run();

    expect(findingsOf(reports, 0)).toEqual([
      expect.objectContaining({ target: "eu", reason: "not-loaded" }),
      expect.objectContaining({ target: "un", reason: "empty", observed: 0 }),
      expect.objectContaining({
        target: "uk",
        reason: "stale",
        observed: staleHours,
      }),
    ]);
    expect(lines.at(0)).toMatchObject({
      invariant: "sanctions.lists_loaded",
      severity: "critical",
      checked: sanctionsSourceIds().length,
      findings: 3,
      DataInvariantUnhealthy: 1,
    });
    expect(
      logs.at("ERROR").map(({ attributes }) => attributes?.["finding.target"]),
    ).toEqual(["eu", "un", "uk"]);
  },
  TIMEOUT,
);

test(
  "a list with too many truncated screenings fires; one at the threshold holds",
  async () => {
    const screened = 40;
    const atThreshold = screened * SANCTIONS_INCOMPLETE_SHARE_MAX;
    // Excluded contacts would halve the share if they counted as screenings.
    await seedScreenings({
      source: "eu",
      total: 2 * screened,
      incomplete: atThreshold + 1,
      excluded: screened,
    });
    await seedScreenings({
      source: "un",
      total: screened,
      incomplete: atThreshold,
    });

    const reports = await run();

    expect(findingsOf(reports, 1)).toEqual([
      {
        target: "eu",
        reason: "incomplete-share",
        observed: (atThreshold + 1) / screened,
        expected: `<= ${SANCTIONS_INCOMPLETE_SHARE_MAX}`,
      },
    ]);
    expect(lines.at(1)).toMatchObject({
      invariant: "sanctions.screening_completeness",
      checked: 2,
      DataInvariantUnhealthy: 1,
    });
  },
  TIMEOUT,
);
