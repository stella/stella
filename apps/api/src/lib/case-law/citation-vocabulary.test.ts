import { describe, expect, test } from "bun:test";

import { POLARITIES, POLARITY } from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";
import {
  CITATION_TREATMENTS,
  GRAPH_DIRECTION,
} from "@/api/lib/case-law/citation-vocabulary";
import type { CitationTreatment } from "@/api/lib/case-law/citation-vocabulary";

/** Both inclusions, so neither list can gain or lose a member on its own. */
type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

/**
 * Every stored polarity that is a reading of the text. `unknown` is the one
 * that is not: it is the pipeline's word about itself, so it is the one
 * stored polarity deliberately without a treatment of its own.
 */
type ReadablePolarity = Exclude<Polarity, typeof POLARITY.UNKNOWN>;

const READABLE_POLARITIES = POLARITIES.filter(
  (polarity): polarity is ReadablePolarity => polarity !== POLARITY.UNKNOWN,
);

describe("the treatment vocabulary and the polarity domain", () => {
  test("are the same set once `unclassified` is taken out, at compile time", () => {
    const bound: AssertEqual<
      ReadablePolarity,
      Exclude<CitationTreatment, "unclassified">
    > = true;

    expect(bound).toBe(true);
  });

  test("are the same set at run time, in both directions", () => {
    const declared: string[] = [...CITATION_TREATMENTS];
    const derived: string[] = [...READABLE_POLARITIES, "unclassified"];

    expect(declared.toSorted()).toEqual(derived.toSorted());
  });

  test("keep every stored polarity readable as a treatment", () => {
    expect(
      READABLE_POLARITIES.every((polarity) =>
        CITATION_TREATMENTS.includes(polarity),
      ),
    ).toBe(true);
  });
});

describe("the agent-facing directions", () => {
  test("name one graph side each", () => {
    expect(GRAPH_DIRECTION).toEqual({
      cites: "outgoing",
      cited_by: "incoming",
    });
  });
});
