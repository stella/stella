import { SEED_RULES } from "../src/handlers/case-law/polarity/seed-rules";

/** SQL literals are escaped independently of regex escaping. */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const renderSeedRuleKindBackfill =
  () => `UPDATE "case_law_polarity_rules" AS rules
SET "kind" = seeds.kind,
    "polarity" = CASE WHEN seeds.kind = 'form' THEN 'neutral' ELSE rules.polarity END
FROM (VALUES
${SEED_RULES.map((rule) => `  (${literal(rule.language)}, ${literal(rule.pattern)}, ${literal(rule.kind)})`).join(",\n")}
) AS seeds(language, pattern, kind)
WHERE rules.language = seeds.language AND rules.pattern = seeds.pattern;`;

if (import.meta.main) {
  console.log(renderSeedRuleKindBackfill());
}
