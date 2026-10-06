import { describe, expect, test } from "bun:test";

import {
  getSpawnSubagentsCallStatus,
  keySpawnSubagents,
  maskSubagentIdentifiers,
  SPAWN_SUBAGENTS_CALL_STATUS,
  SPAWN_SUBAGENTS_CALL_STATUS_BY_STATE,
  subagentTitleRuns,
} from "@/components/chat/spawn-subagents-card.logic";
import type {
  SpawnSubagentsCallStatus,
  SpawnSubagentsToolCallState,
} from "@/components/chat/spawn-subagents-card.logic";

describe("spawn subagent row identity", () => {
  test("is stable when distinct subtasks reorder", () => {
    const first = {
      title: "Authorities",
      task: "Research authorities",
      model: "fast",
    };
    const second = { title: "Citations", task: "Check citations" };

    const original = keySpawnSubagents([first, second]);
    const reordered = keySpawnSubagents([second, first]);

    expect(original.map(({ key }) => key).toSorted()).toEqual(
      reordered.map(({ key }) => key).toSorted(),
    );
  });

  test("disambiguates identical subtasks without using their positions", () => {
    const subagent = { title: "Draft review", task: "Review the draft" };

    const keyed = keySpawnSubagents([subagent, subagent]);

    expect(keyed[0]?.key).not.toBe(keyed[1]?.key);
    expect(keyed.map(({ index }) => index)).toEqual([0, 1]);
  });
});

describe("subagent prompt identifier masking", () => {
  test.each([
    "Find 019dd47d-f507-7c84-b827-980af11b8980 in the matter.",
    "Find 019DD47D-F507-7C84-B827-980AF11B8980 in the matter.",
    "workspaceId=private-matter review the draft",
    '"documentId": "private-document", inspect text',
    "file_id: private-file; inspect text",
    "id='private-row' review text",
    "ID='private-row' review text",
    '"entityID": "private-document", inspect text',
    "FILE_ID: private-file; inspect text",
  ])("masks internal identifiers in %s", (prompt) => {
    const masked = maskSubagentIdentifiers(prompt);
    expect(masked).not.toBe(prompt);
    expect(masked).not.toContain("private-");
    expect(masked).not.toMatch(
      /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/iu,
    );
    expect(masked).toContain("[…]");
    expect(maskSubagentIdentifiers(masked)).toBe(masked);
  });

  test("preserves legal references, links, dates, and ordinary instructions", () => {
    const prompt =
      "Check §§ 576–588 of Act 89/2012, ECLI:CZ:NS:2024:21.CDO.123.2024.1, https://example.test/eli/89/2012 and 2026-10-06. No writes. valid: yes.";
    expect(maskSubagentIdentifiers(prompt)).toBe(prompt);
  });
});

const LONG_NUMBER_RUN_LENGTH = 4096;

describe("subagent title citation isolation", () => {
  test.each([
    ["القانون المدني §§ 576–588", "§§ 576–588"],
    ["أحكام §§ ٥٧٦–٥٨٨،", "§§ ٥٧٦–٥٨٨"],
    ["Civil Code § 576 (validity)", "§ 576"],
    ["Act 89/2012: validity", "89/2012"],
    ["576–588: последствия недействительности", "576–588"],
  ])("isolates citations without changing text: %s", (title, citation) => {
    const runs = subagentTitleRuns(title);
    expect(runs.map(({ text }) => text).join("")).toBe(title);
    expect(
      runs.filter(({ type }) => type === "citation").map(({ text }) => text),
    ).toEqual([citation]);
  });

  test("preserves long number runs and isolates the complete Unicode range", () => {
    const plainNumber = "٥".repeat(LONG_NUMBER_RUN_LENGTH);
    const title = `${plainNumber} validity; ٥٧٦–٥٨٨`;
    const runs = subagentTitleRuns(title);
    expect(runs.map(({ text }) => text).join("")).toBe(title);
    expect(
      runs.filter(({ type }) => type === "citation").map(({ text }) => text),
    ).toEqual(["٥٧٦–٥٨٨"]);
  });

  test.each(["", "القانون المدني", "Draft review", "قانون ٥٧٦"])(
    "preserves titles without citation runs: %s",
    (title) => {
      const runs = subagentTitleRuns(title);
      expect(runs.map(({ text }) => text).join("")).toBe(title);
      expect(runs.every(({ type }) => type === "text")).toBe(true);
    },
  );
});

// Typed against the SDK state union: adding, removing, or renaming a state
// fails typecheck here until its expected card status is chosen.
const EXPECTED_CALL_STATUS = {
  "awaiting-input": SPAWN_SUBAGENTS_CALL_STATUS.running,
  "input-streaming": SPAWN_SUBAGENTS_CALL_STATUS.running,
  "input-complete": SPAWN_SUBAGENTS_CALL_STATUS.running,
  "approval-requested": SPAWN_SUBAGENTS_CALL_STATUS.awaitingApproval,
  "approval-responded": SPAWN_SUBAGENTS_CALL_STATUS.running,
  complete: SPAWN_SUBAGENTS_CALL_STATUS.done,
  error: SPAWN_SUBAGENTS_CALL_STATUS.failed,
} as const satisfies Record<
  SpawnSubagentsToolCallState,
  SpawnSubagentsCallStatus
>;

describe("spawn subagents call status", () => {
  test("decides every tool-call state explicitly", () => {
    expect(SPAWN_SUBAGENTS_CALL_STATUS_BY_STATE).toEqual(EXPECTED_CALL_STATUS);
  });

  test("settles terminal states without a running indicator", () => {
    expect(getSpawnSubagentsCallStatus({ state: "error" })).toBe(
      SPAWN_SUBAGENTS_CALL_STATUS.failed,
    );
    expect(getSpawnSubagentsCallStatus({ state: "complete" })).toBe(
      SPAWN_SUBAGENTS_CALL_STATUS.done,
    );
  });

  test("waits on the user, not on execution, while approval is requested", () => {
    expect(getSpawnSubagentsCallStatus({ state: "approval-requested" })).toBe(
      SPAWN_SUBAGENTS_CALL_STATUS.awaitingApproval,
    );
  });

  test("runs after an approval and settles after a decline", () => {
    expect(
      getSpawnSubagentsCallStatus({
        approval: { approved: true },
        state: "approval-responded",
      }),
    ).toBe(SPAWN_SUBAGENTS_CALL_STATUS.running);
    expect(
      getSpawnSubagentsCallStatus({
        approval: { approved: false },
        state: "approval-responded",
      }),
    ).toBe(SPAWN_SUBAGENTS_CALL_STATUS.declined);
  });
});
