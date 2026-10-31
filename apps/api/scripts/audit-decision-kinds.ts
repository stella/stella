/** Read-only fixture audit. Optional argument: a JSON array of DecisionKindAuditRow exports. */
import { readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import * as v from "valibot";

import inventory from "@/api/lib/case-law/decision-type-inventory.json" with { type: "json" };

import {
  auditDecisionKinds,
  type DecisionKindAuditRow,
} from "./lib/decision-kind-audit";

const rowSchema = v.object({
  id: v.string(),
  source: v.string(),
  court: v.string(),
  ecli: v.optional(v.nullable(v.string())),
  stated: v.nullable(v.string()),
  headings: v.array(v.string()),
});
const fixtureSchema = v.object({
  decisions: v.array(
    v.object({
      id: v.optional(v.string()),
      case_number: v.string(),
      court: v.string(),
      ecli: v.optional(v.nullable(v.string())),
      decision_type: v.optional(v.nullable(v.string())),
      document_ast: v.nullish(
        v.object({
          blocks: v.array(
            v.object({
              role: v.optional(v.string()),
              plainText: v.optional(v.string()),
            }),
          ),
        }),
      ),
    }),
  ),
});
const rows: DecisionKindAuditRow[] = [];
const input = Bun.argv.at(2);
if (input !== undefined) {
  rows.push(
    ...v
      .parse(v.array(rowSchema), await Bun.file(input).json())
      .map((row) => ({ ...row, ecli: row.ecli ?? null })),
  );
} else {
  const directory = `${import.meta.dir}/__fixtures__/case-law`;
  for (const name of (await readdir(directory)).toSorted()) {
    if (!/^(?:cz|sk)-.*\.json\.gz$/u.test(name)) {
      continue;
    }
    const fixture = v.parse(
      fixtureSchema,
      JSON.parse(
        gunzipSync(
          Buffer.from(await Bun.file(`${directory}/${name}`).arrayBuffer()),
        ).toString(),
      ),
    );
    for (const row of fixture.decisions) {
      rows.push({
        id: row.id ?? `${name}:${row.case_number}`,
        source: name.replace(".json.gz", ""),
        court: row.court,
        ecli: row.ecli ?? null,
        stated: row.decision_type ?? null,
        headings: (row.document_ast?.blocks ?? [])
          .filter(({ role }) => role === "decision-title")
          .flatMap(({ plainText }) =>
            plainText === undefined ? [] : [plainText],
          ),
      });
    }
  }
}
console.log(
  JSON.stringify(
    auditDecisionKinds({
      rows,
      vocabulary: {
        ...inventory.jurisdictions,
        ...Object.fromEntries(
          Object.entries(inventory.adapterVocabulary).map(
            ([country, values]) => [`adapter-vocabulary:${country}`, values],
          ),
        ),
      },
    }),
    null,
    2,
  ),
);
