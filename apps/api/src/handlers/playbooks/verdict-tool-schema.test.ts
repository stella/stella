import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { playbookVerdictToolSchema } from "@/api/db/schema-validators";
import type { PlaybookVerdictTool } from "@/api/db/schema-validators";

const ASK_ID = "11111111-1111-4111-8111-111111111111";

const verdictTool: PlaybookVerdictTool = {
  version: 1,
  type: "playbook-verdict",
  askPropertyId: ASK_ID,
  rule: { kind: "positionMatch" },
  severity: "high",
  tiers: {
    ideal: "Governed by the laws of England and Wales.",
    fallbacks: [
      { rank: 0, label: "EU", text: "Governed by the laws of Ireland." },
      { rank: 1, text: "Governed by the laws of Scotland." },
    ],
    acceptableRules: [{ id: "ar-1", text: "A common-law jurisdiction." }],
    notAcceptableRules: [{ id: "nr-1", text: "A sanctioned state." }],
  },
};

describe("playbookVerdictToolSchema — ResolvedTiers embedding", () => {
  test("accepts a verdict tool carrying resolved tiers and round-trips unchanged", () => {
    expect(v.is(playbookVerdictToolSchema, verdictTool)).toBe(true);
    expect(v.parse(playbookVerdictToolSchema, verdictTool)).toEqual(
      verdictTool,
    );
  });

  test("accepts empty tier arrays (a lifted row with no authored content)", () => {
    const empty = {
      ...verdictTool,
      tiers: { fallbacks: [], acceptableRules: [], notAcceptableRules: [] },
    };
    expect(v.is(playbookVerdictToolSchema, empty)).toBe(true);
  });

  test("requires the tiers snapshot", () => {
    const { tiers: _tiers, ...withoutTiers } = verdictTool;
    void _tiers;
    expect(v.is(playbookVerdictToolSchema, withoutTiers)).toBe(false);
  });

  test("rejects a fallback with a negative rank", () => {
    const badRank = {
      ...verdictTool,
      tiers: {
        ...verdictTool.tiers,
        fallbacks: [{ rank: -1, text: "Bad." }],
      },
    };
    expect(v.is(playbookVerdictToolSchema, badRank)).toBe(false);
  });
});
