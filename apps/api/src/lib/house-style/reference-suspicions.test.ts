import { describe, expect, test } from "bun:test";

import { buildLabelIndex } from "@/api/lib/house-style/label-index";
import {
  blockIdOf,
  czechContract,
} from "@/api/lib/house-style/manifest.test-helpers";
import { detectReferences } from "@/api/lib/house-style/reference-detector";
import { findTopicSuspicions } from "@/api/lib/house-style/reference-suspicions";

const suspicionsOf = (citing: string) => {
  const manifest = czechContract(citing);
  const index = buildLabelIndex(manifest);
  const { references } = detectReferences(manifest, index);
  return {
    manifest,
    references,
    suspicions: findTopicSuspicions({ manifest, index, references }),
  };
};

describe("findTopicSuspicions", () => {
  test("a sentence about one article that cites its neighbour", () => {
    // Article XIII is force majeure; safety at work is article XIV.
    const { manifest, references, suspicions } = suspicionsOf(
      "Za porušení pravidel bezpečnosti práce a ochrany zdraví dle čl. XIII této smlouvy zaplatí dodavatel pokutu.",
    );
    expect(suspicions).toEqual([
      {
        referenceId: references.at(0)?.id ?? "",
        designatorIndex: 0,
        citedBlockId: blockIdOf(manifest, "Článek XIII."),
        suggestedBlockId: blockIdOf(manifest, "Článek XIV."),
        reason: "topicMismatch",
        confidence: 0.35,
      },
    ]);
    // The reference itself still points where the text says.
    expect(references.at(0)?.designators.at(0)?.resolution).toMatchObject({
      status: "resolved",
      targetBlockId: blockIdOf(manifest, "Článek XIII."),
    });
  });

  test.each([
    "Za porušení pravidel bezpečnosti práce a ochrany zdraví dle čl. XIV této smlouvy zaplatí dodavatel pokutu.",
    "Plnění může přerušit vyšší moc dle čl. XIII této smlouvy.",
    "Dodavatel postupuje dle čl. II této smlouvy.",
    "Práce dle čl. XIII této smlouvy.",
    "Cenu a platební podmínky upravuje čl. IV této smlouvy; vyšší moc čl. XIII této smlouvy.",
  ])("no suspicion: %s", (citing) => {
    expect(suspicionsOf(citing).suspicions).toEqual([]);
  });
});
