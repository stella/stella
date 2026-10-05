import { panic } from "better-result";

import { reportCorpusHitDispositions } from "@/api/lib/legal-search/corpus-hit-telemetry";

type RehydrationDisposition =
  | { type: "eligible" }
  | { type: "excluded"; reason: "eligibility_rule" }
  | { type: "drift"; reason: "canonical_row_unresolved" };

export const classifyCorpusRehydration = (
  row: { eligible: boolean } | undefined,
): RehydrationDisposition => {
  if (row === undefined) {
    return { type: "drift", reason: "canonical_row_unresolved" };
  }
  if (!row.eligible) {
    return { type: "excluded", reason: "eligibility_rule" };
  }
  return { type: "eligible" };
};

type EligibleCorpusRowsOptions<Row> = {
  family: "case_law" | "legislation";
  ids: readonly string[];
  rows: readonly Row[];
};

/** Counts only: identifiers and excluded row fields never enter telemetry. */
export const eligibleCorpusRows = <
  Row extends { id: string; eligible: boolean },
>({
  family,
  ids,
  rows,
}: EligibleCorpusRowsOptions<Row>): Row[] => {
  const byId = new Map<string, Row>();
  for (const row of rows) {
    byId.set(String(row.id), row);
  }
  let excluded = 0;
  let drift = 0;
  for (const id of new Set(ids)) {
    const disposition = classifyCorpusRehydration(byId.get(id));
    switch (disposition.type) {
      case "eligible":
        break;
      case "excluded":
        excluded += 1;
        break;
      case "drift":
        drift += 1;
        break;
      default:
        disposition satisfies never;
        panic("Unhandled canonical rehydration disposition");
    }
  }
  reportCorpusHitDispositions({
    stage: "rehydration",
    family,
    excluded,
    drift,
  });
  return rows.filter((row) => row.eligible);
};
