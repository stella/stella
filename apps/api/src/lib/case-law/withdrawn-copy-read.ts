import { abortTransaction } from "@/api/lib/db/transaction-abort";
import {
  getRequestContext,
  getRequestUiLocale,
} from "@/api/lib/observability/request-context";

import { readWithdrawnCopies } from "./withdrawn-copies";
import { decisionReferencesIn } from "./withdrawn-copy-projection";

type ReadCopyOptions = Parameters<typeof readWithdrawnCopies>[0] & {
  snapshot?: "request" | "fresh";
};
type CopyRead = ReturnType<typeof readWithdrawnCopies>;
type RequestBatch = {
  reader: ReadCopyOptions["caseLawDb"];
  locale: ReadCopyOptions["locale"];
  references: ReadonlySet<string>;
  read: CopyRead;
};
const requestBatches = new WeakMap<object, RequestBatch[]>();

/** Read callbacks reject on unavailable status rather than serving unchecked copies. */
export const readWithdrawnCopyProjection = async (options: ReadCopyOptions) => {
  const { snapshot, ...readOptions } = options;
  const locale = options.locale ?? getRequestUiLocale();
  const references = decisionReferencesIn(options.values);
  if (options.decisionIds !== undefined) {
    for (const id of options.decisionIds) {
      references.add(id.toLowerCase());
    }
  }
  const scope = snapshot === "fresh" ? undefined : getRequestContext();
  let batches: RequestBatch[] = [];
  if (scope !== undefined) {
    const existing = requestBatches.get(scope);
    if (existing !== undefined) {
      batches = existing;
    }
  }
  let batch = batches.find(
    (candidate) =>
      candidate.reader === options.caseLawDb &&
      candidate.locale === locale &&
      [...references].every((id) => candidate.references.has(id)),
  );
  if (batch === undefined) {
    batch = {
      reader: options.caseLawDb,
      locale,
      references,
      read: readWithdrawnCopies({ ...readOptions, locale }),
    };
    batches.push(batch);
    if (scope !== undefined) {
      requestBatches.set(scope, batches);
    }
  }
  const read = await batch.read;
  if (read.isErr()) {
    return abortTransaction(read.error);
  }
  return read.value;
};
