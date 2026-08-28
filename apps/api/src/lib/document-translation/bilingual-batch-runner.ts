import { panic, Result } from "better-result";

/** Larger than the interactive flow's batch because formatted-output repair
 *  can retry individual rejected rows without replaying the accepted ones. */
export const DOCUMENT_TRANSLATION_BATCH_SIZE = 16;

type RunBilingualTranslationBatchesOptions<TItem, TError> = {
  items: readonly TItem[];
  translate: (batch: readonly TItem[]) => Promise<Result<void, TError>>;
};

/**
 * Translate bounded row batches in document order. Each call can therefore
 * use the preceding call's target text as legal and terminological context.
 * A failure fences every later batch so retries do not multiply metered work.
 */
export const runBilingualTranslationBatches = async <TItem, TError>({
  items,
  translate,
}: RunBilingualTranslationBatchesOptions<TItem, TError>): Promise<
  Result<void, TError>
> => {
  const batches: TItem[][] = [];
  for (
    let index = 0;
    index < items.length;
    index += DOCUMENT_TRANSLATION_BATCH_SIZE
  ) {
    batches.push(items.slice(index, index + DOCUMENT_TRANSLATION_BATCH_SIZE));
  }

  const runBatch = async (index: number): Promise<Result<void, TError>> => {
    if (index >= batches.length) {
      return Result.ok();
    }
    const batch = batches.at(index);
    if (!batch) {
      panic("Bilingual translation batch index is out of bounds");
    }
    const outcome = await translate(batch);
    if (Result.isError(outcome)) {
      return outcome;
    }
    return await runBatch(index + 1);
  };

  return await runBatch(0);
};
