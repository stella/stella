import { describe, expect, test } from "bun:test";

import {
  parseStagingState,
  StagingStateError,
  stagingCheckDisposition,
  stagingFailureDisposition,
} from "../helpers/staging-state";

describe("staging state", () => {
  test("makes only a check with its declared report-only value report-only", () => {
    const state = parseStagingState('{"corpus_index":"off","rollout":"on"}');

    expect(stagingCheckDisposition(state, "public-law-hydration")).toEqual({
      mode: "report-only",
      reason: "corpus_index=off",
    });
    expect(stagingCheckDisposition(state, "public-knowledge-flags")).toEqual({
      mode: "gating",
    });
  });

  test("keeps declared on and absent states gating", () => {
    expect(
      stagingCheckDisposition(
        parseStagingState('{"corpus_index":"on"}'),
        "public-law-hydration",
      ),
    ).toEqual({ mode: "gating" });
    expect(
      stagingCheckDisposition(
        parseStagingState(undefined),
        "public-law-hydration",
      ),
    ).toEqual({ mode: "gating" });
    expect(
      stagingCheckDisposition(parseStagingState(""), "public-knowledge-flags"),
    ).toEqual({ mode: "gating" });
  });

  test("matches each declared report-only state to only its own tagged failure", () => {
    const stateCases = [
      {
        raw: '{"corpus_index":"off","rollout":"knowledge-web-pending"}',
        expected: ["report-only", "report-only"],
      },
      {
        raw: '{"corpus_index":"off","rollout":"on"}',
        expected: ["report-only", "gating"],
      },
      {
        raw: '{"corpus_index":"on","rollout":"knowledge-web-pending"}',
        expected: ["gating", "report-only"],
      },
      {
        raw: '{"corpus_index":"on","rollout":"on"}',
        expected: ["gating", "gating"],
      },
    ] as const;

    for (const { raw, expected } of stateCases) {
      const state = parseStagingState(raw);
      expect(
        stagingFailureDisposition(state, ["@staging-public-law-hydration"])
          .mode,
      ).toBe(expected[0]);
      expect(
        stagingFailureDisposition(state, ["@staging-public-knowledge-flags"])
          .mode,
      ).toBe(expected[1]);
    }
  });

  test("keeps untagged, unknown-tagged, and multiply tagged failures gating", () => {
    const state = parseStagingState(
      '{"corpus_index":"off","rollout":"knowledge-web-pending"}',
    );
    for (const tags of [
      [],
      ["@unknown"],
      ["@staging-public-law-hydration", "@unknown"],
      ["@staging-public-law-hydration", "@staging-public-knowledge-flags"],
    ]) {
      expect(stagingFailureDisposition(state, tags)).toEqual({
        mode: "gating",
      });
    }
  });

  test("rejects malformed JSON, invalid shapes, unknown keys, and invalid values", () => {
    for (const raw of [
      " ",
      "{",
      "[]",
      '"on"',
      '{"unknown":"on"}',
      '{"corpus_index":"pending"}',
      '{"rollout":"off"}',
      '{"corpus_index":null}',
      '{"rollout":3}',
    ]) {
      expect(() => parseStagingState(raw)).toThrow(StagingStateError);
    }
  });
});
