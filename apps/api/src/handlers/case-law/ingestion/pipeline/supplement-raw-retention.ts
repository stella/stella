import type { SafeId } from "@/api/lib/branded-types";
import { writeOwnedRawPayload } from "@/api/lib/legal-search/text-retention/retained-raw";
import { readStoredRawFromS3 } from "@/api/lib/legal-search/text-retention/stored-raw";

import type { IngestionResult } from "../adapter";
import type { StoredSupplement } from "../supplement-composition";
import type { RawWriteState } from "./decision-raw";

type RetainSupplementRawOptions = {
  supplements: readonly StoredSupplement[];
  input: IngestionResult;
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
  rawWrites: RawWriteState;
};

/** Copy before absorption can erase a former standalone decision's prefix. */
export const retainSupplementRaw = async ({
  supplements,
  input,
  sourceId,
  decisionId,
  rawWrites,
}: RetainSupplementRawOptions) => {
  const retained = [];
  for (const supplement of supplements) {
    const key = supplement.sourceRawS3Key ?? null;
    // db-await-in-loop: each content-addressed supplement belongs to this decision's bounded composition, before any database locks
    const read = key === null ? null : await readStoredRawFromS3(key);
    if (read?.isErr()) {
      throw read.error;
    }
    const raw = read?.value ?? null;
    if (raw === null) {
      retained.push({ supplement, preparedRaw: null });
      continue;
    }
    const written = await writeOwnedRawPayload({
      result: { ...input, sourceRawBytes: raw, sourceRawObjects: undefined },
      sourceId,
      ownerId: decisionId,
      contentType: supplement.sourceRawContentType ?? "text/plain",
      storedKey: key,
      storedContentType: supplement.sourceRawContentType ?? null,
      window: rawWrites.window,
      onWriteStart: () => {
        rawWrites.attempted = true;
      },
    });
    if (written.isErr()) {
      throw written.error;
    }
    retained.push({ supplement, preparedRaw: written.value ?? null });
  }
  return retained;
};

export type RetainedSupplementRaw = Awaited<
  ReturnType<typeof retainSupplementRaw>
>;
