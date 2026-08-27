import { describe, expect, test } from "bun:test";

import {
  allowsDerivedAi,
  isRedistributable,
} from "@/api/lib/legal-search/corpus-source";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";

const RESTRICTED: CorpusSourceDescriptor = {
  license: "restricted",
  attribution: "Publisher",
  allowsRedistribution: false,
  allowsDerivedAi: false,
};

describe("corpus source reuse terms", () => {
  test("honours an explicit descriptor in both directions", () => {
    expect(isRedistributable(RESTRICTED)).toBe(false);
    expect(allowsDerivedAi(RESTRICTED)).toBe(false);
    expect(
      isRedistributable({
        ...RESTRICTED,
        license: "public-domain",
        allowsRedistribution: true,
      }),
    ).toBe(true);
    expect(
      allowsDerivedAi({
        ...RESTRICTED,
        license: "public-domain",
        allowsDerivedAi: true,
      }),
    ).toBe(true);
  });

  // A legacy source predating the field carries no descriptor, and no
  // creation path writes one, so both answers stay permissive. Pinned here so
  // tightening either one is a deliberate edit with a backfill behind it
  // rather than a quiet change that empties the corpus.
  test("treats a source with no stated terms as permissive", () => {
    expect(isRedistributable(null)).toBe(true);
    expect(isRedistributable(undefined)).toBe(true);
    expect(allowsDerivedAi(null)).toBe(true);
    expect(allowsDerivedAi(undefined)).toBe(true);
  });
});
