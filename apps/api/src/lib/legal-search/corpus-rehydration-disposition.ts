import type { CorpusHitDispositionCounter } from "@/api/lib/legal-search/corpus-hit-telemetry";

type CorpusRehydrationDisposition = Parameters<
  CorpusHitDispositionCounter["recordCanonical"]
>[0];

type PartitionCorpusRehydrationOptions<Row> = {
  ids: readonly string[];
  records: readonly { id: string; row: Row | null }[];
};

type ReturnedCorpusDisposition = Omit<CorpusRehydrationDisposition, "type"> & {
  type: "excluded";
};

/** Explicit null records withhold content without probing another relation. */
export const partitionReturnedCorpusRecords = <Row>(
  records: readonly { id: string; row: Row | null }[],
) => {
  const rows: Row[] = [];
  const dispositions: ReturnedCorpusDisposition[] = [];
  for (const { id, row } of records) {
    if (row === null) {
      dispositions.push({ id, type: "excluded" });
    } else {
      rows.push(row);
    }
  }
  return { rows, dispositions };
};

/** Readers whose relation can omit requested ids also report those omissions. */
export const partitionCorpusRehydration = <Row>({
  ids,
  records,
}: PartitionCorpusRehydrationOptions<Row>) => {
  const returned = partitionReturnedCorpusRecords(records);
  const dispositions: CorpusRehydrationDisposition[] = [
    ...returned.dispositions,
  ];
  const found = new Set(records.map(({ id }) => id));
  for (const id of new Set(ids)) {
    if (!found.has(id)) {
      dispositions.push({ id, type: "drift" });
    }
  }
  return { rows: returned.rows, dispositions };
};

export const recordCorpusRehydrationDispositions = (
  dispositions: readonly CorpusRehydrationDisposition[],
  counter: CorpusHitDispositionCounter,
): void => {
  for (const disposition of dispositions) {
    counter.recordCanonical(disposition);
  }
};
