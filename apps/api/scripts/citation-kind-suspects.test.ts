import { describe, expect, test } from "bun:test";

import {
  parseReviewCitations,
  rankCitationKindSuspects,
} from "./citation-kind-suspects";

const citation = {
  id: "example",
  country: "CZ",
  citationText: "21 Cdo 123/2020",
  context: null,
  sentence: null,
};

describe("offline citation kind review", () => {
  test("reports a cue overriding a published registry", () => {
    const [suspect] = rankCitationKindSuspects([
      {
        ...citation,
        context: "Napadený rozsudek 21 Cdo 123/2020.",
        sentence: "Napadený rozsudek 21 Cdo 123/2020.",
      },
    ]);
    expect(suspect?.reasons).toEqual(["cue-registry-conflict"]);
  });

  test("reports cues outside the supplied sentence, including a cancelled tie", () => {
    const [suspect] = rankCitationKindSuspects([
      {
        ...citation,
        context: "Napadený rozsudek byl zrušen. Srov. 21 Cdo 123/2020.",
        sentence: "Srov. 21 Cdo 123/2020.",
      },
    ]);
    expect(suspect?.reasons).toEqual(["cue-outside-sentence"]);
  });

  test("keeps unlisted registries distinct from proven mistakes", () => {
    const [suspect] = rankCitationKindSuspects([
      {
        ...citation,
        citationText: "12 Co 123/2020",
      },
    ]);
    expect(suspect?.reasons).toEqual(["unlisted-registry"]);
    expect(rankCitationKindSuspects([citation])).toEqual([]);
  });

  test("ranks CZ and SK first, then severity, independently of input order", () => {
    const rows = [
      { ...citation, id: "low", citationText: "12 Co 123/2020" },
      { ...citation, id: "high", country: "SK", context: "Napadený rozsudek" },
      { ...citation, id: "other", country: "PL", context: "Napadený rozsudek" },
    ];
    const ranked = rankCitationKindSuspects(rows);
    expect(ranked.map(({ id }) => id)).toEqual(["high", "low", "other"]);
    expect(rankCitationKindSuspects(rows.toReversed())).toEqual(ranked);
    expect(rows.at(0)?.id).toBe("low");
  });

  test("rejects malformed input and accepts blank JSONL lines", () => {
    expect(parseReviewCitations(`\n${JSON.stringify(citation)}\n`)).toEqual([
      citation,
    ]);
    expect(() => parseReviewCitations('{"id":"incomplete"}')).toThrow(
      "Invalid",
    );
  });
});
