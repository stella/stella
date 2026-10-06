import type { CorpusHitDispositionCounter } from "@/api/lib/legal-search/corpus-hit-telemetry";

type CorpusRehydrationDisposition = Parameters<
  CorpusHitDispositionCounter["recordCanonical"]
>[0];

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
  for (const disposition of dispositions) {
    counter.recordCanonical(disposition);
  }
};
