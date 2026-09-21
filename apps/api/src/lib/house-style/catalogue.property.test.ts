import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import {
  chainStyleId,
  chainStylesXml,
  HOUSE_NUMBERING_XML,
} from "@/api/lib/house-style/__fixtures__/synthetic-style-set";
import { readStyleDefinitions } from "@/api/lib/house-style/catalogue";

/**
 * What one style of a `w:basedOn` chain declares: no `w:numPr` at all, the
 * reserved `w:numId` 0 that turns numbering off, or one of the lists
 * `HOUSE_NUMBERING_XML` defines.
 */
const DECLARATIONS = [null, 0, 1, 2, 3] as const;

const MAX_CHAIN_LENGTH = 6;

/**
 * What Word resolves for the style at `depth`: the nearest ancestor that
 * declares anything decides, and the reserved 0 decides "none". Written out
 * plainly here so the property compares the reader against the rule rather
 * than against itself.
 */
const resolvedNumId = (
  chain: readonly (number | null)[],
  depth: number,
): number | null => {
  for (let index = depth; index >= 0; index -= 1) {
    const declared = chain.at(index);
    if (declared === null || declared === undefined) {
      continue;
    }
    return declared === 0 ? null : declared;
  }
  return null;
};

describe("numbering over a basedOn chain (properties)", () => {
  test("every style resolves to its nearest declaring ancestor", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...DECLARATIONS), {
          minLength: 1,
          maxLength: MAX_CHAIN_LENGTH,
        }),
        (chain) => {
          const { byId } = readStyleDefinitions({
            stylesXml: chainStylesXml(chain),
            numberingXml: HOUSE_NUMBERING_XML,
          });
          for (let depth = 0; depth < chain.length; depth += 1) {
            const style = byId.get(chainStyleId(depth));
            expect(style?.formatting.numbering?.numId ?? null).toBe(
              resolvedNumId(chain, depth),
            );
          }
        },
      ),
      propertyConfig({ numRuns: 300, seed: propertySeed() }),
    );
  });

  test("a style under a cancelling one is numbered only if it says so", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...DECLARATIONS), {
          minLength: 1,
          maxLength: MAX_CHAIN_LENGTH,
        }),
        fc.constantFrom(...DECLARATIONS),
        (ancestors, own) => {
          // The reserved 0 sits between the ancestors and the last style, so
          // nothing above it can reach that style.
          const chain = [...ancestors, 0, own];
          const { byId } = readStyleDefinitions({
            stylesXml: chainStylesXml(chain),
            numberingXml: HOUSE_NUMBERING_XML,
          });
          const deepest = byId.get(chainStyleId(chain.length - 1));
          expect(deepest?.formatting.numbering?.numId ?? null).toBe(
            own === null || own === 0 ? null : own,
          );
        },
      ),
      propertyConfig({ numRuns: 300, seed: propertySeed() }),
    );
  });
});
