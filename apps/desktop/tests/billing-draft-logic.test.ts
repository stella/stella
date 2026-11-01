import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import * as v from "valibot";

import { AI_DISCLOSURES } from "@stll/api-contract/ai-disclosure";
import {
  DESKTOP_BILLING_DRAFT_LIMITS,
  desktopBillingDraftRequestSchema,
} from "@stll/api-contract/desktop-billing-drafts";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import requestFixture from "../fixtures/billing-draft-request.json";
import {
  CARD_DRAFT_ENTRY_ID,
  cardDraftEntry,
  cardDraftFrom,
  DRAFT_FAILURE_KINDS,
  draftFailureKind,
  partitionRanges,
  scopedDraftSettingsFrom,
  structureItems,
} from "../src/activity/billing-draft-logic";
import type { CardStructure } from "../src/activity/billing-draft-logic";
import type { MatchedSegment } from "../src/activity/day-review-logic";
import en from "../src/i18n/langs/en.json";

const MATTER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_MATTER_ID = "00000000-0000-4000-8000-000000000002";
/** The card's entry: its matter and the 30 minutes it recorded. */
const TARGET = { matterId: MATTER_ID, durationMinutes: 30 };

const segment = (
  fields: Partial<Pick<MatchedSegment, "document" | "windowTitle">>,
): MatchedSegment => ({
  appIdentifier: "com.example.editor",
  appName: "Example Editor",
  document: null,
  windowTitle: null,
  matterId: MATTER_ID,
  call: false,
  startMs: 0,
  endMs: 60_000,
  matter: null,
  confidence: "strong",
  evidence: [],
  drafted: false,
  ...fields,
});

const suggestion = {
  apps: [
    { identifier: "com.example.editor", name: "Example Editor", durationMs: 1 },
    { identifier: "com.example.mail", name: "Mail", durationMs: 1 },
  ],
  segments: [
    segment({
      document: "/Volumes/Matters/Lease v3.docx",
      windowTitle: "Lease v3.docx",
    }),
    segment({ windowTitle: "Re: break clause" }),
  ],
  roundedTenths: 5,
};

const entry = (captureDetails: boolean) =>
  cardDraftEntry({
    suggestion,
    matterId: MATTER_ID,
    date: "2026-11-01",
    timezone: "Europe/Prague",
    captureDetails,
  });

describe("a card's drafting request", () => {
  test("carries the entry's matter, date, duration and app names, and no titles while titles are not recorded", () => {
    expect(entry(false)).toEqual({
      entryId: CARD_DRAFT_ENTRY_ID,
      matterId: MATTER_ID,
      date: "2026-11-01",
      timezone: "Europe/Prague",
      durationMinutes: 30,
      appNames: ["Example Editor", "Mail"],
    });
  });

  test("adds the document names and window titles the card shows when titles are recorded, each once", () => {
    expect(entry(true).evidence).toEqual({
      documentNames: ["Lease v3.docx"],
      windowTitles: ["Re: break clause"],
    });
  });

  test("holds the server's request contract", () => {
    for (const captureDetails of [false, true]) {
      expect(
        v.safeParse(desktopBillingDraftRequestSchema, {
          entries: [entry(captureDetails)],
        }).success,
      ).toBe(true);
    }
  });

  test("clips each name to the contract's length and keeps at most the contract's number", () => {
    const long = "\u{1F600}".repeat(DESKTOP_BILLING_DRAFT_LIMITS.nameLength);
    const many = cardDraftEntry({
      suggestion: {
        ...suggestion,
        segments: Array.from(
          { length: DESKTOP_BILLING_DRAFT_LIMITS.evidenceItems + 5 },
          (_, index) => segment({ windowTitle: `${long}${String(index)}` }),
        ),
      },
      matterId: MATTER_ID,
      date: "2026-11-01",
      timezone: "Europe/Prague",
      captureDetails: true,
    });
    const titles = many.evidence?.windowTitles ?? [];
    expect(titles.length).toBeLessThanOrEqual(
      DESKTOP_BILLING_DRAFT_LIMITS.evidenceItems,
    );
    for (const title of titles) {
      expect(title.length).toBeLessThanOrEqual(
        DESKTOP_BILLING_DRAFT_LIMITS.nameLength,
      );
      // No half surrogate pair is left at the cut.
      expect(title.isWellFormed()).toBe(true);
    }
  });
});

describe("drafting failures", () => {
  test("the window names every failure the native boundary sends", () => {
    expect(requestFixture.failures.map(({ type }) => type)).toEqual([
      ...DRAFT_FAILURE_KINDS,
    ]);
    for (const { type } of requestFixture.failures) {
      expect<string>(draftFailureKind({ type })).toBe(type);
    }
  });

  test("anything the boundary does not name is one generic failure", () => {
    for (const cause of [
      undefined,
      null,
      "billing draft request failed",
      { type: "guidelinesRequired" },
      { type: "__proto__" },
    ]) {
      expect(draftFailureKind(cause)).toBe("failed");
    }
  });
});

const earlier = (id: string) => ({
  id,
  dateWorked: "2026-10-30",
  durationMinutes: 42,
  narrative: `Earlier entry ${id}`,
});

describe("a card's draft", () => {
  test("a plain draft fills the description and shows only the earlier entries it followed", () => {
    expect(
      cardDraftFrom(
        {
          result: {
            mode: "plain",
            drafts: [
              {
                entryId: CARD_DRAFT_ENTRY_ID,
                narrative: "Reviewed the break clause of the lease.",
                matchedEarlierEntryIds: [
                  "00000000-0000-4000-8000-0000000000a1",
                ],
              },
            ],
          },
          earlierEntries: [
            earlier("00000000-0000-4000-8000-0000000000a1"),
            earlier("00000000-0000-4000-8000-0000000000a2"),
          ],
        },
        TARGET,
      ),
    ).toEqual({
      narrative: "Reviewed the break clause of the lease.",
      earlierEntries: [earlier("00000000-0000-4000-8000-0000000000a1")],
      classification: null,
      billable: null,
      flags: [],
      structure: null,
      result: expect.objectContaining({ mode: "plain" }),
    });
  });

  test("a guided draft adds its codes and its notes against the guidelines, each with the file and section it cites", () => {
    expect(
      cardDraftFrom(
        {
          result: {
            mode: "guided",
            drafts: [
              {
                entryId: CARD_DRAFT_ENTRY_ID,
                narrative: "Analysed the termination provisions.",
                classification: {
                  type: "ledes",
                  taskCode: "L120",
                  activityCode: "A104",
                },
                flags: [
                  {
                    text: "Block billing: list each task separately.",
                    ruleRef: {
                      fileId: "guideline-1",
                      fileName: "Outside counsel guidelines.pdf",
                      section: "4.2",
                    },
                  },
                ],
                matchedEarlierEntryIds: [],
                operations: [],
              },
            ],
            checkedGuidelines: [
              {
                fileId: "guideline-1",
                fileName: "Outside counsel guidelines.pdf",
              },
            ],
          },
          earlierEntries: [],
        },
        TARGET,
      ),
    ).toEqual({
      narrative: "Analysed the termination provisions.",
      earlierEntries: [],
      classification: { type: "ledes", taskCode: "L120", activityCode: "A104" },
      billable: null,
      flags: [
        {
          text: "Block billing: list each task separately.",
          fileName: "Outside counsel guidelines.pdf",
          section: "4.2",
          fix: null,
        },
      ],
      structure: null,
      result: expect.objectContaining({ mode: "guided" }),
    });
  });

  test("an answer outside the contract or without the card's entry is no draft", () => {
    for (const value of [
      null,
      { result: { mode: "plain", drafts: [] }, earlierEntries: [] },
      {
        result: {
          mode: "plain",
          drafts: [
            {
              entryId: "entry_2",
              narrative: "Someone else's entry",
              matchedEarlierEntryIds: [],
            },
          ],
        },
        earlierEntries: [],
      },
      { result: { mode: "plain" }, earlierEntries: [] },
    ]) {
      expect(cardDraftFrom(value, TARGET)).toBeNull();
    }
  });
});

const LEDES = {
  type: "ledes",
  taskCode: "L120",
  activityCode: "A104",
} as const;
const GROUP = { type: "activity_group", activityGroup: "internal" } as const;

/** A guided answer whose one draft carries these operations and flags. */
const guided = (operations: unknown[], flags: unknown[] = []): unknown => ({
  result: {
    mode: "guided",
    drafts: [
      {
        entryId: CARD_DRAFT_ENTRY_ID,
        narrative: "Reviewed the lease.",
        classification: LEDES,
        flags,
        matchedEarlierEntryIds: [],
        operations,
      },
    ],
    checkedGuidelines: [{ fileId: "guideline-1", fileName: "Guidelines.pdf" }],
  },
  earlierEntries: [],
});

const splitInto = (...minutes: number[]): CardStructure => ({
  type: "split",
  parts: minutes.map((durationMinutes, index) => ({
    durationMinutes,
    narrative: `Part ${String(index + 1)}`,
    classification: LEDES,
    billable: true,
  })),
});

const moveOf = (
  durationMinutes: number,
  targetMatterId = OTHER_MATTER_ID,
): CardStructure => ({
  type: "move",
  targetMatterId,
  targetMatterName: "Other matter",
  durationMinutes,
  narrative: "Called the other client.",
  classification: GROUP,
  billable: false,
});

describe("a guided draft's operations", () => {
  test("rewrites, classification changes and the billable choice apply in order", () => {
    const draft = cardDraftFrom(
      guided([
        { type: "rewrite", narrative: "First rewrite." },
        { type: "change_classification", classification: GROUP },
        { type: "set_billable", billable: false },
        { type: "rewrite", narrative: "Second rewrite." },
      ]),
      TARGET,
    );
    expect(draft).toMatchObject({
      narrative: "Second rewrite.",
      classification: GROUP,
      billable: false,
      structure: null,
    });
  });

  test("a split is offered only when its parts add up to the recorded minutes", () => {
    expect(
      cardDraftFrom(guided([splitInto(10, 20)]), TARGET)?.structure,
    ).toEqual(splitInto(10, 20));
    for (const parts of [
      [10, 25],
      [10, 10],
    ]) {
      expect(
        cardDraftFrom(guided([splitInto(...parts)]), TARGET)?.structure,
      ).toBeNull();
    }
  });

  test("a move is offered only for recorded minutes and another matter", () => {
    expect(cardDraftFrom(guided([moveOf(30)]), TARGET)?.structure).toEqual(
      moveOf(30),
    );
    expect(cardDraftFrom(guided([moveOf(10)]), TARGET)?.structure).toEqual(
      moveOf(10),
    );
    expect(cardDraftFrom(guided([moveOf(31)]), TARGET)?.structure).toBeNull();
    expect(
      cardDraftFrom(guided([moveOf(10, MATTER_ID)]), TARGET)?.structure,
    ).toBeNull();
  });

  test("a merge is never offered on a card, which drafts a single entry", () => {
    const draft = cardDraftFrom(
      guided([
        {
          type: "merge",
          entryIds: [CARD_DRAFT_ENTRY_ID, "entry_2"],
          narrative: "Merged.",
          classification: LEDES,
          billable: true,
        },
      ]),
      TARGET,
    );
    expect(draft).toMatchObject({
      narrative: "Reviewed the lease.",
      structure: null,
    });
  });

  test("a note a split fixes says so", () => {
    const draft = cardDraftFrom(
      guided(
        [splitInto(15, 15)],
        [
          {
            text: "Block billing.",
            ruleRef: {
              fileId: "guideline-1",
              fileName: "Guidelines.pdf",
              section: "2",
            },
            fix: "split",
          },
        ],
      ),
      TARGET,
    );
    expect(draft?.flags).toEqual([
      {
        text: "Block billing.",
        fileName: "Guidelines.pdf",
        section: "2",
        fix: "split",
      },
    ]);
  });
});

const DAY_START = Temporal.Instant.from(
  "2026-11-01T08:00:00Z",
).epochMilliseconds;
const at = (minutes: number) =>
  Temporal.Instant.fromEpochMilliseconds(
    DAY_START + minutes * 60_000,
  ).toString();
const ms = (instant: string) =>
  Temporal.Instant.from(instant).epochMilliseconds;
const total = (list: readonly { start: string; end: string }[]) =>
  list.reduce((sum, { start, end }) => sum + ms(end) - ms(start), 0);

test(
  "range partitions conserve time, keep order and never overlap",
  () => {
    assertProperty(
      "range partitions conserve time, keep order and never overlap",
      fc.property(
        fc
          .array(
            fc.tuple(
              fc.integer({ min: 0, max: 30 }),
              fc.integer({ min: 1, max: 90 }),
            ),
            { minLength: 1, maxLength: 6 },
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

describe("an accepted split or move", () => {
  const card = {
    matterId: MATTER_ID,
    narrative: "Typed by the user.",
    billable: true,
    classification: null,
  };
  // 30 recorded minutes in two stretches with a gap between them.
  const ranges = [
    { start: at(0), end: at(20) },
    { start: at(40), end: at(50) },
  ];
  const options = {
    card,
    durationMinutes: 30,
    ranges,
    date: "2026-11-01",
    timezoneId: "Europe/Prague",
  };

  test("a split creates each part on the card's matter, in time order", () => {
    const items = structureItems({
      ...options,
      structure: splitInto(10, 20),
    });
    expect(items.map((item) => item.entry)).toEqual([
      {
        matterId: MATTER_ID,
        dateWorked: "2026-11-01",
        timezoneId: "Europe/Prague",
        durationMinutes: 10,
        narrative: "Part 1",
        billable: true,
        classification: LEDES,
      },
      {
        matterId: MATTER_ID,
        dateWorked: "2026-11-01",
        timezoneId: "Europe/Prague",
        durationMinutes: 20,
        narrative: "Part 2",
        billable: true,
        classification: LEDES,
      },
    ]);
    expect(items.map((item) => item.ranges)).toEqual([
      [{ start: at(0), end: at(10) }],
      [
        { start: at(10), end: at(20) },
        { start: at(40), end: at(50) },
      ],
    ]);
  });

  test("a partial move keeps the rest on the card as the user left it", () => {
    const items = structureItems({
      ...options,
      structure: moveOf(10),
    });
    expect(items.map((item) => item.entry)).toEqual([
      {
        matterId: MATTER_ID,
        dateWorked: "2026-11-01",
        timezoneId: "Europe/Prague",
        durationMinutes: 20,
        narrative: "Typed by the user.",
        billable: true,
      },
      {
        matterId: OTHER_MATTER_ID,
        dateWorked: "2026-11-01",
        timezoneId: "Europe/Prague",
        durationMinutes: 10,
        narrative: "Called the other client.",
        billable: false,
        classification: GROUP,
      },
    ]);
    expect(items.map((item) => total(item.ranges))).toEqual([
      20 * 60_000,
      10 * 60_000,
    ]);
  });

  test("a whole move creates one entry on the other matter over all the time", () => {
    const items = structureItems({
      ...options,
      structure: moveOf(30),
    });
    expect(items).toEqual([
      {
        entry: expect.objectContaining({
          matterId: OTHER_MATTER_ID,
          durationMinutes: 30,
        }),
        ranges,
      },
    ]);
  });
});

describe("drafting settings from the native boundary", () => {
  const settings = {
    revision: null,
    effectiveMode: "plain",
    consent: "revoked",
    preference: null,
  } as const;

  test("an answer names the account it belongs to", () => {
    expect(
      scopedDraftSettingsFrom({ scopeKey: '["firm","user"]', settings }),
    ).toEqual({ scopeKey: '["firm","user"]', settings });
  });

  test("an answer without its account or outside the contract is refused", () => {
    for (const value of [
      settings,
      { scopeKey: "", settings },
      {
        scopeKey: '["firm","user"]',
        settings: { ...settings, consent: "yes" },
      },
      {
        scopeKey: '["firm","user"]',
        settings: { ...settings, organizationMode: "enabled" },
      },
    ]) {
      expect(scopedDraftSettingsFrom(value)).toBeNull();
    }
  });
});

test("the card's AI disclosure is the shared billing drafts disclosure", () => {
  expect(en.activity.aiDraftDisclosure).toBe(AI_DISCLOSURES.billingDrafts.text);
});
