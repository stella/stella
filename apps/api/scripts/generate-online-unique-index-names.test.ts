import { expect, test } from "bun:test";

import { deriveOnlineUniqueIndexNames } from "./generate-online-unique-index-names";

const source = `
const executable = { name: "records_priorTokenHash_idx", isUnique: true };
export const EXECUTABLE_ONLINE_UNIQUE_INDEXES = [executable] as const;
const additional = [{ name: "records_secondary_idx", isUnique: true }];
export const ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS = [
  ...EXECUTABLE_ONLINE_UNIQUE_INDEXES,
  ...additional,
  ...REWRITTEN_MIGRATION_INDEXES.filter(({ isUnique }) => isUnique),
];
`;
const rewrittenIndexes = [
  {
    name: "records_rewritten_idx",
    definitionBody: "ON public.records USING btree (id)",
    tableName: "records",
    isUnique: true,
  },
  {
    name: "records_nonunique_idx",
    definitionBody: "ON public.records USING btree (id)",
    tableName: "records",
    isUnique: false,
  },
];

test("projects every declaration and unique inventory index with strict export names", () => {
  const output = deriveOnlineUniqueIndexNames({ source, rewrittenIndexes });
  expect(output).not.toContain("export const RECORDS_");
  expect(output).toContain(
    'const RECORDS_PRIOR_TOKEN_HASH_IDX = "records_priorTokenHash_idx";',
  );
  expect(output).toContain(
    'const RECORDS_REWRITTEN_IDX = "records_rewritten_idx";',
  );
  expect(output).toContain(
    'const RECORDS_SECONDARY_IDX = "records_secondary_idx";',
  );
  expect(output).not.toContain("records_nonunique_idx");
  expect(output).toContain(
    "export const EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES = {RECORDS_PRIOR_TOKEN_HASH_IDX} as const;",
  );
  expect(output).toContain(
    "export const ONLINE_UNIQUE_INDEX_NAMES = {RECORDS_PRIOR_TOKEN_HASH_IDX,RECORDS_REWRITTEN_IDX,RECORDS_SECONDARY_IDX} as const;",
  );
  expect(
    deriveOnlineUniqueIndexNames({
      source,
      rewrittenIndexes: rewrittenIndexes.toReversed(),
    }),
  ).toBe(output);
});

test("a new spread declaration enters the projection without a second inventory", () => {
  const expanded = source.replace(
    "...additional,",
    '...additional, ...[{ name: "records_added_idx", isUnique: true }],',
  );
  expect(expanded).not.toBe(source);
  expect(
    deriveOnlineUniqueIndexNames({ source: expanded, rewrittenIndexes }),
  ).toContain('const RECORDS_ADDED_IDX = "records_added_idx";');
});

test.each([
  [
    "missing",
    source.replace("ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS", "OTHER"),
  ],
  ["dynamic", source.replace('"records_secondary_idx"', "readName()")],
  ["unsupported spread", source.replace("...additional,", "...readIndexes(),")],
  [
    "duplicate",
    source.replace('"records_secondary_idx"', '"records_priorTokenHash_idx"'),
  ],
  [
    "colliding export",
    source.replace('"records_secondary_idx"', '"records_prior_token_hash_idx"'),
  ],
])("fails closed for %s declarations", (_case, changedSource) => {
  expect(() =>
    deriveOnlineUniqueIndexNames({ source: changedSource, rewrittenIndexes }),
  ).toThrow(
    /(?:Missing online index declaration|Online index name must be a declaration literal|Duplicate online index export)/u,
  );
});
