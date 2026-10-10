// Attributes derived from the data they describe, each with the one detector
// module that computes it.
//
// `no-literal-derived-attribute` (oxlint.config.ts) reads this table: under a
// row's `within` trees, a boolean literal written to the attribute anywhere
// but its detector is an error. `.oxlint-plugins/__tests__/
// no-literal-derived-attribute.test.ts` checks that every detector exists and
// exports its detector function, that the writer test exists, and that the
// lint override carries every row. Add a row together with its detector and the
// writer-enumerating test beside it.

type DerivedAttribute = {
  /** The property name every writer of the attribute uses. */
  readonly name: string;
  /** Repository-relative path of the module that computes it. */
  readonly detector: string;
  /** An export of `detector` that computes the attribute from the data. */
  readonly detectorExport: string;
  /** Repository-relative source trees the ban applies to. */
  readonly within: readonly string[];
  /** The test that enumerates the attribute's writers. */
  readonly writersTest: string;
};

export const DERIVED_ATTRIBUTES = [
  {
    name: "encrypted",
    detector: "apps/api/src/lib/files/detect-file-encryption.ts",
    detectorExport: "detectFileEncryption",
    within: ["apps/api/src/"],
    writersTest: "apps/api/src/lib/files/file-encryption-writers.test.ts",
  },
] as const satisfies readonly DerivedAttribute[];
