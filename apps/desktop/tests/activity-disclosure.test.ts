import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

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
// and each field a request built from recorded activity sends, is mapped here
// to the fact that discloses it. A field added without a mapping fails, and
// so does a fact no field backs any more.

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

/** Fields that carry nothing about the day: request bookkeeping, the
 *  user's own typed instruction, or the server's earlier answer. */
const NOT_ABOUT_THE_DAY = "notAboutTheDay";

/** A field the user sets, not one the recorder captures. */
const CHOSEN_BY_YOU = "chosenByYou";

type Disclosed<Fact> = Fact | readonly Fact[];

const RECORDED_FIELDS = {
  "activity.rs": {
    ActivitySegment: {
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
  Record<
    string,
    Record<string, Disclosed<ActivityRecordedFact | typeof CHOSEN_BY_YOU>>
  >
>;

const SENT_FIELDS = {
  "billing_draft_submit.rs": {
    DraftEntry: {
      app_names: "aiDrafts",
      date: "aiDrafts",
      duration_minutes: "aiDrafts",
      entry_id: NOT_ABOUT_THE_DAY,
      evidence: "aiDrafts",
      matter_id: "aiDrafts",
      timezone: "aiDrafts",
    },
    DraftEvidence: {
      document_names: "aiDrafts",
      window_titles: "aiDrafts",
    },
    DraftRequest: {
      entries: "aiDrafts",
      previous_result: NOT_ABOUT_THE_DAY,
      steer: NOT_ABOUT_THE_DAY,
    },
  },
  "time_entry_submit.rs": {
    ConfirmedBatch: {
      entries: "timeEntries",
      idempotency_key: NOT_ABOUT_THE_DAY,
    },
    ConfirmedTimeEntry: {
      billable: "timeEntries",
      classification: "timeEntries",
      date_worked: "timeEntries",
      duration_minutes: "timeEntries",
      matter_id: "timeEntries",
      narrative: "timeEntries",
      timezone_id: "timeEntries",
    },
  },
} as const satisfies Record<
  string,
  Record<
    string,
    Record<string, Disclosed<ActivitySentFact | typeof NOT_ABOUT_THE_DAY>>
  >
>;

type FieldMap = Record<string, Record<string, Record<string, unknown>>>;

const factsOf = (fields: FieldMap) =>
  new Set(
    Object.values(fields)
      .flatMap((byStruct) => Object.values(byStruct))
      .flatMap((mapping) => Object.values(mapping))
      .flat(),
  );

describe("the activity disclosure", () => {
  const every: FieldMap[] = [RECORDED_FIELDS, SENT_FIELDS];
  for (const fields of every) {
    for (const [file, byStruct] of Object.entries(fields)) {
      for (const [name, mapping] of Object.entries(byStruct)) {
        test(`maps every field of ${file}: ${name} to a fact`, () => {
          expect(structFields(file, name).toSorted()).toEqual(
            Object.keys(mapping).toSorted(),
          );
        });
      }
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
