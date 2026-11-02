import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { AI_DISCLOSURES } from "@stll/api-contract/ai-disclosure";
import {
  DESKTOP_BILLING_DRAFT_LIMITS,
  desktopBillingDraftRequestSchema,
} from "@stll/api-contract/desktop-billing-drafts";

import requestFixture from "../fixtures/billing-draft-request.json";
import {
  CARD_DRAFT_ENTRY_ID,
  cardDraftEntry,
  cardDraftFrom,
  DRAFT_FAILURE_KINDS,
  draftFailureKind,
  scopedDraftSettingsFrom,
} from "../src/activity/billing-draft-logic";
import type { MatchedSegment } from "../src/activity/day-review-logic";
import en from "../src/i18n/langs/en.json";

const MATTER_ID = "00000000-0000-4000-8000-000000000001";

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
      cardDraftFrom({
        result: {
          mode: "plain",
          drafts: [
            {
              entryId: CARD_DRAFT_ENTRY_ID,
              narrative: "Reviewed the break clause of the lease.",
              matchedEarlierEntryIds: ["00000000-0000-4000-8000-0000000000a1"],
            },
          ],
        },
        earlierEntries: [
          earlier("00000000-0000-4000-8000-0000000000a1"),
          earlier("00000000-0000-4000-8000-0000000000a2"),
        ],
      }),
    ).toEqual({
      narrative: "Reviewed the break clause of the lease.",
      earlierEntries: [earlier("00000000-0000-4000-8000-0000000000a1")],
      classification: null,
      flags: [],
      result: expect.objectContaining({ mode: "plain" }),
    });
  });

  test("a guided draft adds its codes and its notes against the guidelines, each with the file and section it cites", () => {
    expect(
      cardDraftFrom({
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
      }),
    ).toEqual({
      narrative: "Analysed the termination provisions.",
      earlierEntries: [],
      classification: { type: "ledes", taskCode: "L120", activityCode: "A104" },
      flags: [
        {
          text: "Block billing: list each task separately.",
          fileName: "Outside counsel guidelines.pdf",
          section: "4.2",
        },
      ],
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
      expect(cardDraftFrom(value)).toBeNull();
    }
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
