import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { caseLawJudges } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { logger } from "@/api/lib/observability/logger";
import {
  isMissingCorpusObjectError,
  readCorpusS3ObjectBounded,
} from "@/api/lib/s3";

/**
 * Where the portrait of one judge is served from, relative to the API root.
 *
 * The decision read hands this to its client rather than a signed object URL:
 * the route is cacheable, carries no credential, and stays valid for as long
 * as the judge does.
 */
export const judgePortraitPath = (judgeId: SafeId<"caseLawJudge">): string =>
  `${STELLA_API_VERSION_PREFIX}/case/judges/${judgeId}/portrait`;

/** A portrait is a head-and-shoulders image; nothing stored here is larger. */
export const PORTRAIT_MAX_BYTES = 4 * 1024 * 1024;

export const PORTRAIT_CACHE_CONTROL = "public, max-age=86400";

export type JudgePortraitPointer = {
  key: string;
  contentType: string;
};

/**
 * The stored portrait's location, or null when this judge has none.
 *
 * The four portrait columns are one fact by CHECK constraint, so a key
 * implies a content type; the read still states both, because the row is what
 * decides the served header.
 */
export const readJudgePortraitPointer = async (
  tx: CaseLawPublicReadTransaction,
  judgeId: SafeId<"caseLawJudge">,
): Promise<JudgePortraitPointer | null> => {
  const [judge] = await tx
    .select({
      key: caseLawJudges.portraitS3Key,
      contentType: caseLawJudges.portraitContentType,
    })
    .from(caseLawJudges)
    .where(eq(caseLawJudges.id, judgeId))
    .limit(1);

  const key = judge?.key ?? null;
  const contentType = judge?.contentType ?? null;
  if (key === null || contentType === null) {
    return null;
  }
  return { key, contentType };
};

export type JudgePortraitObject = {
  bytes: Uint8Array;
  etag: string | null;
};

/**
 * The portrait's bytes, or null when the store confirms the object is gone.
 *
 * A row pointing at an absent object is a defect in the import, not in the
 * request, so it is reported here and answered as a portrait this judge does
 * not have. Every other store failure still fails the read.
 */
export const readJudgePortraitObject = async (
  { key }: JudgePortraitPointer,
  signal: AbortSignal,
): Promise<JudgePortraitObject | null> => {
  const read = await Result.tryPromise({
    try: async () =>
      await readCorpusS3ObjectBounded({
        key,
        maxBytes: PORTRAIT_MAX_BYTES,
        signal,
      }),
    catch: (cause) => cause,
  });
  if (Result.isOk(read)) {
    return read.value;
  }
  if (isMissingCorpusObjectError(read.error)) {
    logger.error("case_law.judge_portrait_object_absent", { key });
    return null;
  }
  throw read.error;
};
