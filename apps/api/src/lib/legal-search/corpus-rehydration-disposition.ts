import { panic } from "better-result";

import type { CorpusHitDispositionCounter } from "@/api/lib/legal-search/corpus-hit-telemetry";

type CorpusRehydrationDisposition = {
  id: string;
  type: "excluded" | "drift";
};

type PartitionCorpusRehydrationOptions<Row> = {
  ids: readonly string[];
  records: readonly { id: string; row: Row | null }[];
};

/** Content is selected only by the SQL-gated branch; omissions carry ids only. */
export const partitionCorpusRehydration = <Row>({
  ids,
  records,
}: PartitionCorpusRehydrationOptions<Row>) => {
  const rows: Row[] = [];
  const dispositions: CorpusRehydrationDisposition[] = [];
  const found = new Set<string>();
  for (const { id, row } of records) {
    found.add(id);
    if (row === null) {
      dispositions.push({ id, type: "excluded" });
    } else {
      rows.push(row);
    }
  }
  for (const id of new Set(ids)) {
    if (!found.has(id)) {
      dispositions.push({ id, type: "drift" });
    }
  }
  return { rows, dispositions };
};

export const recordCorpusRehydrationDispositions = (
  dispositions: readonly CorpusRehydrationDisposition[],
  counter: CorpusHitDispositionCounter,
): void => {
  let excluded = 0;
  let drift = 0;
  for (const disposition of dispositions) {
    switch (disposition.type) {
      case "excluded":
        excluded += 1;
        break;
      case "drift":
        drift += 1;
        break;
      default:
        disposition.type satisfies never;
        panic("Unhandled canonical rehydration disposition");
    }
  }
  counter.record({ excluded, drift });
};
