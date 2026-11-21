import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  desktopBillingDraftEntrySchema,
  desktopBillingDraftEvidenceSchema,
  desktopBillingDraftRequestSchema,
} from "@stll/api-contract/desktop-billing-drafts";
import {
  desktopTimeEntryBatchItemSchema,
  desktopTimeEntryBatchSchema,
} from "@stll/api-contract/desktop-time-entries";

import {
  ACTIVITY_RECORDED,
  ACTIVITY_SENT,
} from "../src/activity/activity-disclosure";
import type {
  ActivityRecordedFact,
  ActivitySentFact,
} from "../src/activity/activity-disclosure";

// Setup and the Activity window tell the user what Activity records and what
// leaves the computer. Each field the native side keeps per stretch of time,
// and each field of a request built from recorded activity, both as the
// native side sends it and as the API contract accepts it, is mapped here to
// the fact that discloses it. A field added without a mapping fails, and so
// does a fact no field backs any more.

const NATIVE_SOURCE = path.join(import.meta.dir, "../src-tauri/src");

/** Field names of `struct name` in a native source file, as declared. */
const structFields = (file: string, name: string) => {
  const source = readFileSync(path.join(NATIVE_SOURCE, file), "utf-8");
  const start = source.indexOf(`pub struct ${name} {`);
  expect(start, `${file}: ${name}`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  return [
    ...body.matchAll(/^[ \t]+(?:pub(?:\([a-z]+\))?[ \t]+)?([a-z_]+):/gmu),
  ].flatMap((match) => (match[1] ? [match[1]] : []));
};

/** Fields that carry nothing about the day: request bookkeeping, or the
 *  server's own earlier answer sent back for a refinement. */
const NOT_ABOUT_THE_DAY = "notAboutTheDay";

/** A field the user sets, not one the recorder captures. */
const CHOSEN_BY_YOU = "chosenByYou";

type Disclosed<Fact> = Fact | readonly Fact[];

type FieldGroup<Fact> = {
  /** The fields as declared, read from their owner. */
  fields: () => string[];
  /** Each field, by the fact that discloses it. */
  mapping: Record<string, Disclosed<Fact>>;
};

const RECORDED_FIELDS = {
  "activity.rs: ActivitySegment": {
    fields: () => structFields("activity.rs", "ActivitySegment"),
    mapping: {
      app_identifier: "app",
      app_name: "app",
      call: "calls",
      document: "details",
      end: "activeTime",
      matter_id: CHOSEN_BY_YOU,
      start: "activeTime",
      window_title: ["details", "browserTitles"],
    },
  },
} as const satisfies Record<
  string,
  FieldGroup<ActivityRecordedFact | typeof CHOSEN_BY_YOU>
>;

const DRAFT_ENTRY = {
  app_names: "aiDrafts",
  date: "aiDrafts",
  duration_minutes: "aiDrafts",
  entry_id: NOT_ABOUT_THE_DAY,
  evidence: "aiDrafts",
  matter_id: "aiDrafts",
  timezone: "aiDrafts",
} as const;

const DRAFT_EVIDENCE = {
  document_names: "aiDrafts",
  window_titles: "aiDrafts",
} as const;

const DRAFT_REQUEST = {
  entries: "aiDrafts",
  previous_result: NOT_ABOUT_THE_DAY,
  steer: "aiDrafts",
} as const;

const TIME_ENTRY = {
  billable: "timeEntries",
  classification: "timeEntries",
  date_worked: "timeEntries",
  duration_minutes: "timeEntries",
  matter_id: "timeEntries",
  narrative: "timeEntries",
  timezone_id: "timeEntries",
} as const;

const TIME_ENTRY_BATCH = {
  entries: "timeEntries",
  idempotency_key: NOT_ABOUT_THE_DAY,
} as const;

/** The contract spells fields in camelCase; the native side in snake_case. */
const snakeCase = (name: string) =>
  name.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

const contractFields = (entries: Record<string, unknown>) => () =>
  Object.keys(entries).map(snakeCase);

const SENT_FIELDS = {
  "billing_draft_submit.rs: DraftEntry": {
    fields: () => structFields("billing_draft_submit.rs", "DraftEntry"),
    mapping: DRAFT_ENTRY,
  },
  "billing_draft_submit.rs: DraftEvidence": {
    fields: () => structFields("billing_draft_submit.rs", "DraftEvidence"),
    mapping: DRAFT_EVIDENCE,
  },
  "billing_draft_submit.rs: DraftRequest": {
    fields: () => structFields("billing_draft_submit.rs", "DraftRequest"),
    mapping: DRAFT_REQUEST,
  },
  "time_entry_submit.rs: ConfirmedBatch": {
    fields: () => structFields("time_entry_submit.rs", "ConfirmedBatch"),
    mapping: TIME_ENTRY_BATCH,
  },
  "time_entry_submit.rs: ConfirmedTimeEntry": {
    fields: () => structFields("time_entry_submit.rs", "ConfirmedTimeEntry"),
    mapping: TIME_ENTRY,
  },
  desktopBillingDraftEntrySchema: {
    fields: contractFields(desktopBillingDraftEntrySchema.entries),
    mapping: DRAFT_ENTRY,
  },
  desktopBillingDraftEvidenceSchema: {
    fields: contractFields(desktopBillingDraftEvidenceSchema.entries),
    mapping: DRAFT_EVIDENCE,
  },
  desktopBillingDraftRequestSchema: {
    fields: contractFields(desktopBillingDraftRequestSchema.pipe[0].entries),
    mapping: DRAFT_REQUEST,
  },
  desktopTimeEntryBatchSchema: {
    fields: contractFields(desktopTimeEntryBatchSchema.entries),
    mapping: TIME_ENTRY_BATCH,
  },
  desktopTimeEntryBatchItemSchema: {
    fields: contractFields(desktopTimeEntryBatchItemSchema.entries),
    mapping: TIME_ENTRY,
  },
} as const satisfies Record<
  string,
  FieldGroup<ActivitySentFact | typeof NOT_ABOUT_THE_DAY>
>;

const factsOf = (groups: Record<string, FieldGroup<string>>) =>
  new Set(
    Object.values(groups)
      .flatMap(({ mapping }) => Object.values(mapping))
      .flat(),
  );

describe("the activity disclosure", () => {
  const every: Record<string, FieldGroup<string>>[] = [
    RECORDED_FIELDS,
    SENT_FIELDS,
  ];
  for (const groups of every) {
    for (const [label, { fields, mapping }] of Object.entries(groups)) {
      test(`maps every field of ${label} to a fact`, () => {
        expect(fields().toSorted()).toEqual(Object.keys(mapping).toSorted());
      });
    }
  }

  test("states every recorded fact a field backs, and no other", () => {
    const backed = factsOf(RECORDED_FIELDS);
    backed.delete(CHOSEN_BY_YOU);
    expect([...backed].toSorted()).toEqual([...ACTIVITY_RECORDED].toSorted());
  });

  test("states every way activity leaves the computer, and no other", () => {
    const backed = factsOf(SENT_FIELDS);
    backed.delete(NOT_ABOUT_THE_DAY);
    expect([...backed].toSorted()).toEqual([...ACTIVITY_SENT].toSorted());
  });
});
