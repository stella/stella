// oxlint-disable no-template-curly-in-string -- these strings are the linted source, not templates.
import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-raw-case-number-key-equality";

// The comparisons the owner replaced, as they were written: the resolver's
// holder joins and reverse reopens, the exact lookup and the identifier
// backfill. Each is a line, so a regression names the shape it missed.
test("rejects the raw key comparisons the match key replaced", async () => {
  const source = [
    "sql`AND ${holder}.citation_key = ${familyKey}`;",
    "sql`AND identifier.normalized_value = coalesce(${normalizedIdentifierValue}, ${citationKey})`;",
    "sql`AND existing_identifier.normalized_value = ${citationKey}`;",
    "sql`AND c.citation_key = ${citationKey} AND ${reopenable}`;",
    "sql`WHERE c.citation_key = ANY (${keys})`;",
    "sql`AND arriving.normalized_value = coalesce(citation.normalized_identifier_value, citation.citation_key)`;",
    "sql`ON cited_identifier.type = arriving.type AND cited_identifier.normalized_value = arriving.normalized_value`;",
    "sql`AND holder.citation_key IS NOT DISTINCT FROM moved.normalized_value`;",
    "sql`AND changed.normalized_value = ${effective}`;",
    "eq(caseLawDecisionIdentifiers.normalizedValue, onlyKey);",
    "inArray(caseLawDecisionIdentifiers.normalizedValue, keys);",
    "inArray(publishedCaseLawDecisions.citationKey, [...own.keys]);",
    "sql`AND ${caseLawCitationDoctrineReviews.citationKey} = ${caseLawCitations.citationKey}`;",
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
  ]);
});

test("rejects every spelling of a key column on either side", async () => {
  const source = [
    `const a = 'WHERE "citation_key" = $1';`,
    `const b = 'WHERE d."normalized_value" IN ($1, $2)';`,
    "const c = 'WHERE $1 = d.citation_key';",
    "const d = 'WHERE $1 = ANY (c.normalized_identifier_value)';",
    "const e = 'WHERE CITATION_KEY = $1';",
    "sql`WHERE ${t.normalizedIdentifierValue} IN (${values})`;",
    "sql`WHERE ${value} = ${t.citationKey}`;",
    "sql`WHERE ${value} = ANY (${t.normalizedValue})`;",
    "ne(row.citationKey, other);",
    "notInArray(row.normalizedValue, keys);",
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);
});

test("accepts the owner's fragments, writes and other columns", async () => {
  const source = [
    "sql`AND ${caseNumberKeysMatchSql(sql`${holder}.citation_key`, citationKey)}`;",
    "caseNumberKeyAmongSql(caseLawDecisionIdentifiers.normalizedValue, keys);",
    "ecliKeyAmongSql(caseLawDecisionIdentifiers.normalizedValue, keys);",
    "ecliKeysMatchSql(hostEcli.normalizedValue, ownEcli.normalizedValue);",
    "sql`UPDATE c SET citation_key = ${key}, normalized_identifier_value = ${value}`;",
    "sql`SET identifier_type = projected.type,\n normalized_identifier_value = projected.normalized_value`;",
    "sql`ON CONFLICT (decision_id) DO UPDATE SET citation_key = EXCLUDED.citation_key`;",
    "sql`UPDATE ${t} SET ${t.citationKey} = ${key}`;",
    "sql`UPDATE ${t} SET ${t.court} = ${court}, ${t.citationKey} = ${key}`;",
    "sql`WHERE ${t.citationKey} IS NOT NULL AND ${t.citationKey} <> ''`;",
    "sql`WHERE c.citation_key IS NOT NULL AND c.citation_key <> ''`;",
    "sql`OR citation.normalized_identifier_value IS DISTINCT FROM projected.normalized_value`;",
    "sql`WHERE r.reviewed_citation_key = ${key}`;",
    "sql`WHERE d.docket_family_key = ${key} AND d.citation_key >= ${floor}`;",
    "const columns = 'citation_key, normalized_value';",
    "eq(caseLawDecisions.docketFamilyKey, key);",
    "row.citationKey === key;",
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([]);
});
