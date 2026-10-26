import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { AI_DISCLOSURES } from "@stll/api-contract/ai-disclosure";
import { desktopBillingDraftRequestSchema } from "@stll/api-contract/desktop-billing-drafts";
import type { DesktopBillingDraft } from "@stll/api-contract/desktop-billing-drafts";
import type { DesktopTimeEntryMatterCandidate } from "@stll/api-contract/desktop-time-entries";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import {
  draftRequestEntries,
  draftScalars,
  partitionRanges,
  resolveStructure,
  reviewItems,
} from "../src/activity/billing-draft-logic";
import type {
  DraftableGroup,
  ReviewRow,
} from "../src/activity/billing-draft-logic";
import messages from "../src/i18n/langs/en.json";

const DAY_START = Temporal.Instant.from(
  "2026-10-24T07:00:00Z",
).epochMilliseconds;
const at = (minutes: number) =>
  Temporal.Instant.fromEpochMilliseconds(
    DAY_START + minutes * 60_000,
  ).toString();
const ms = (instant: string) =>
  Temporal.Instant.from(instant).epochMilliseconds;

const candidate = (
  id: string,
  name: string,
): DesktopTimeEntryMatterCandidate => ({
  id,
  name,
  reference: null,
  color: null,
  clientName: null,
  signals: {
    lastWorkedAt: null,
    newlyAssignedAt: null,
    upcomingDeadline: null,
  },
});
const RIVERSIDE = candidate(
  "00000000-0000-4000-8000-000000000001",
  "Riverside",
);
const MERIDIAN = candidate("00000000-0000-4000-8000-000000000002", "Meridian");

const group = ({
  id,
  matter,
  minutes,
  ranges,
}: {
  id: string;
  matter: DesktopTimeEntryMatterCandidate;
  minutes: number;
  ranges: [number, number][];
}): DraftableGroup => ({
  id,
  matter,
  confidence: "strong",
  evidence: ["Lease v3.docx", "Re: break clause"],
  apps: [
    { identifier: "word", name: "Word", durationMs: 1 },
    { identifier: "mail", name: "Mail", durationMs: 1 },
  ],
  segments: ranges.map(([start, end], index) => ({
    appIdentifier: index === 0 ? "word" : "mail",
    appName: index === 0 ? "Word" : "Mail",
    document: index === 0 ? "/srv/matters/riverside/Lease v3.docx" : null,
    windowTitle: index === 0 ? "Lease v3.docx" : "Re: break clause",
    matterId: matter.id,
    call: false,
    startMs: DAY_START + start * 60_000,
    endMs: DAY_START + end * 60_000,
    matter,
    confidence: "strong",
    evidence: [],
    drafted: false,
  })),
  ranges: ranges.map(([start, end]) => ({ start: at(start), end: at(end) })),
  durationMs: minutes * 60_000,
  roundedTenths: minutes / 6,
});

const classification = {
  type: "activity_group",
  activityGroup: "client",
} as const;

describe("draft request", () => {
  const groups = [
    group({
      id: RIVERSIDE.id,
      matter: RIVERSIDE,
      minutes: 60,
      ranges: [
        [0, 30],
        [40, 70],
      ],
    }),
  ];

  test("carries titles only when the user records them", () => {
    const withTitles = draftRequestEntries({
      groups,
      date: "2026-10-24",
      timezone: "Europe/Prague",
      captureDetails: true,
    });
    expect(withTitles).toEqual([
      {
        matterId: RIVERSIDE.id,
        date: "2026-10-24",
        timezone: "Europe/Prague",
        durationMinutes: 60,
        appNames: ["Word", "Mail"],
        evidence: {
          documentNames: ["Lease v3.docx"],
          windowTitles: ["Re: break clause"],
        },
      },
    ]);
    const withoutTitles = draftRequestEntries({
      groups,
      date: "2026-10-24",
      timezone: "Europe/Prague",
      captureDetails: false,
    });
    expect(withoutTitles.at(0)).not.toHaveProperty("evidence");
    for (const entries of [withTitles, withoutTitles]) {
      expect(
        v.safeParse(desktopBillingDraftRequestSchema, { entries }).success,
      ).toBe(true);
      // Nothing beyond the request allowlist: no paths, ranges or segments.
      expect(JSON.stringify(entries)).not.toContain("/srv/matters");
      expect(JSON.stringify(entries)).not.toContain("T07:");
    }
  });

  test("bounds every name to the contract", () => {
    const long = group({
      id: "long",
      matter: RIVERSIDE,
      minutes: 6,
      ranges: [[0, 6]],
    });
    const title = `${"😀".repeat(300)}x`;
    const segment =
      long.segments.at(0) ?? panic("title fixture requires a segment");
    segment.document = null;
    segment.windowTitle = title;
    const [entry] = draftRequestEntries({
      groups: [long],
      date: "2026-10-24",
      timezone: "Europe/Prague",
      captureDetails: true,
    });
    const clipped = entry?.evidence?.windowTitles.at(0) ?? "";
    expect(clipped.length).toBeLessThanOrEqual(512);
    expect(clipped.isWellFormed()).toBe(true);
    expect(
      v.safeParse(desktopBillingDraftRequestSchema, { entries: [entry] })
        .success,
    ).toBe(true);
  });
});

const PARTITION_PROPERTY =
  "billing draft range partitions conserve time, keep order and never overlap";

test(
  PARTITION_PROPERTY,
  () => {
    assertProperty(
      PARTITION_PROPERTY,
      fc.property(
        fc
          .array(
            fc.tuple(
              fc.integer({ min: 0, max: 30 }),
              fc.integer({ min: 1, max: 90 }),
            ),
            {
              minLength: 1,
              maxLength: 6,
            },
          )
          .map((gapsAndLengths) => {
            let cursor = 0;
            return gapsAndLengths.map(([gap, length]) => {
              const start = cursor + gap;
              cursor = start + length;
              return { start: at(start), end: at(cursor) };
            });
          }),
        fc.array(fc.integer({ min: 1, max: 600 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (ranges, weights) => {
          const parts = partitionRanges(ranges, weights);
          expect(parts).toHaveLength(weights.length);
          const flat = parts.flat();
          const total = (list: { start: string; end: string }[]) =>
            list.reduce((sum, { start, end }) => sum + ms(end) - ms(start), 0);
          expect(total(flat)).toBe(total(ranges));
          for (const part of parts) {
            expect(total(part)).toBeGreaterThan(0);
          }
          for (const [index, range] of flat.entries()) {
            expect(ms(range.end)).toBeGreaterThan(ms(range.start));
            const next = flat.at(index + 1);
            if (next) {
              expect(ms(next.start)).toBeGreaterThanOrEqual(ms(range.end));
            }
            expect(
              ranges.some(
                ({ start, end }) =>
                  ms(start) <= ms(range.start) && ms(range.end) <= ms(end),
              ),
            ).toBe(true);
          }
        },
      ),
    );
  },
  propertyTestTimeout(5000),
);

describe("accepted proposals become batch items", () => {
  const riverside = group({
    id: RIVERSIDE.id,
    matter: RIVERSIDE,
    minutes: 60,
    ranges: [
      [0, 30],
      [40, 70],
    ],
  });
  const meridian = group({
    id: MERIDIAN.id,
    matter: MERIDIAN,
    minutes: 30,
    ranges: [[100, 130]],
  });
  const row = (
    target: DraftableGroup,
    structure: ReviewRow["structure"] = null,
  ): ReviewRow => ({
    group: target,
    narrative: "Reviewed lease",
    billable: true,
    classification,
    structure,
  });
  const part = (durationMinutes: number, narrative: string) => ({
    durationMinutes,
    narrative,
    classification,
    billable: true,
  });

  test("split keeps the duration and divides the recorded time", () => {
    const items = reviewItems([
      row(riverside, {
        type: "split",
        summary: { type: "split", parts: 3 },
        parts: [part(18, "Call"), part(24, "Drafting"), part(18, "Email")],
      }),
    ]);
    expect(items.map(({ durationMinutes }) => durationMinutes)).toEqual([
      18, 24, 18,
    ]);
    expect(items.map(({ narrative }) => narrative)).toEqual([
      "Call",
      "Drafting",
      "Email",
    ]);
    expect(items.every(({ ranges }) => ranges.length > 0)).toBe(true);
  });

  test("move keeps the remainder on the source matter", () => {
    const structure = resolveStructure({
      structure: {
        type: "move",
        targetMatterId: MERIDIAN.id,
        targetMatterName: "Meridian",
        durationMinutes: 24,
        narrative: "Supply terms",
        classification,
        billable: true,
      },
      groupIds: [riverside.id],
      candidates: [RIVERSIDE, MERIDIAN],
    });
    const items = reviewItems([row(riverside, structure)]);
    expect(
      items.map(({ matter, durationMinutes }) => [
        matter.name,
        durationMinutes,
      ]),
    ).toEqual([
      ["Riverside", 36],
      ["Meridian", 24],
    ]);
  });

  test("merge absorbs the named groups into one entry", () => {
    const structure = resolveStructure({
      structure: {
        type: "merge",
        entryIds: ["entry_1", "entry_2"],
        narrative: "Combined",
        classification,
        billable: true,
      },
      groupIds: [riverside.id, meridian.id],
      candidates: [RIVERSIDE, MERIDIAN],
    });
    const items = reviewItems([row(riverside, structure), row(meridian)]);
    expect(items).toHaveLength(1);
    expect(items.at(0)?.durationMinutes).toBe(90);
    expect(items.at(0)?.ranges).toHaveLength(3);
  });

  test("a merge naming an entry outside the selection is not applicable", () => {
    expect(
      resolveStructure({
        structure: {
          type: "merge",
          entryIds: ["entry_1", "entry_3"],
          narrative: "Combined",
          classification,
          billable: true,
        },
        groupIds: [riverside.id, meridian.id],
        candidates: [RIVERSIDE, MERIDIAN],
      }),
    ).toBeNull();
  });
});

test("scalar operations override the draft's own text, code and billable choice", () => {
  const draft: DesktopBillingDraft = {
    entryId: "entry_1",
    narrative: "Draft",
    classification,
    flags: [],
    matchedEarlierEntryIds: [],
    operations: [
      { type: "rewrite", narrative: "Shorter" },
      {
        type: "change_classification",
        classification: {
          type: "ledes",
          taskCode: "L120",
          activityCode: "A103",
        },
      },
      { type: "set_billable", billable: false },
    ],
  };
  expect(draftScalars(draft)).toEqual({
    narrative: "Shorter",
    classification: { type: "ledes", taskCode: "L120", activityCode: "A103" },
    billable: false,
  });
});

test("the English catalogue says exactly what the contract discloses", () => {
  expect(messages.aiDisclosure.billingDrafts).toBe(
    AI_DISCLOSURES.billingDrafts.text,
  );
});
