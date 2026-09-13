import { describe, expect, test } from "bun:test";

import {
  CLASSIFIABLE_POLARITIES,
  POLARITIES,
  POLARITY,
} from "@/api/handlers/case-law/polarity/consts";
import type { ClassifiablePolarity } from "@/api/handlers/case-law/polarity/consts";
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

describe("the treatment vocabulary and the polarity domain", () => {
  test("are the same set once `unclassified` is taken out, at compile time", () => {
    const bound: AssertEqual<
      ClassifiablePolarity,
      Exclude<CitationTreatment, "unclassified">
    > = true;

    expect(bound).toBe(true);
  });

  test("are the same set at run time, in both directions", () => {
    const declared: string[] = [...CITATION_TREATMENTS];
    const derived: string[] = [...CLASSIFIABLE_POLARITIES, "unclassified"];

    expect(declared.sort()).toEqual(derived.sort());
  });

  test("keep every stored polarity readable as a treatment", () => {
    // `unknown` is the pipeline's word about itself, so it is the one stored
    // polarity that is deliberately not a treatment of its own.
    expect(
      POLARITIES.filter((polarity) => polarity !== POLARITY.UNKNOWN).every(
        (polarity) => CITATION_TREATMENTS.includes(polarity),
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
