import { eq, sql } from "drizzle-orm";

import {
  caseNumberKeyAmongSql,
  caseNumberKeysMatchSql,
} from "../../apps/api/src/lib/case-law/case-number-match-key";

declare const key: string;
declare const holder: ReturnType<typeof sql>;
declare const identifiers: { normalizedValue: ReturnType<typeof sql> };

// oxlint-disable-next-line no-raw-case-number-key-equality/no-raw-case-number-key-equality -- fixture proves a raw holder join is reported
const _rawJoin = sql`AND ${holder}.citation_key = ${key}`;
// oxlint-disable-next-line no-raw-case-number-key-equality/no-raw-case-number-key-equality -- fixture proves a raw membership test is reported
const _rawAny = sql`WHERE c.citation_key = ANY (${[key]})`;
// oxlint-disable-next-line no-raw-case-number-key-equality/no-raw-case-number-key-equality -- fixture proves a Drizzle equality on a key column is reported
const _rawEq = eq(identifiers.normalizedValue, key);

// expect-clean: no-raw-case-number-key-equality/no-raw-case-number-key-equality
const _owned = caseNumberKeysMatchSql(sql`${holder}.citation_key`, sql`${key}`);
// expect-clean: no-raw-case-number-key-equality/no-raw-case-number-key-equality
const _ownedAmong = caseNumberKeyAmongSql(identifiers.normalizedValue, [key]);
// expect-clean: no-raw-case-number-key-equality/no-raw-case-number-key-equality
const _write = sql`UPDATE case_law_citations SET citation_key = ${key}`;
