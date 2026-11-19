import { Result } from "better-result";
import { asc, eq } from "drizzle-orm";

import type { DecisionBodySource } from "@stll/api-contract/case-law-body-source";
import { sha256Hex } from "@stll/sha256/bun";

import { caseLawCollectionBodies, caseLawSources } from "@/api/db/schema";
import {
  parseCzNsSbirkaText,
  readCzNsSbirkaPage,
} from "@/api/handlers/case-law/ingestion/parsers/cz-ns-sbirka";
import type { CzNsSbirkaDocumentIdentity } from "@/api/handlers/case-law/ingestion/parsers/cz-ns-sbirka";
import { readStoredRawFromS3 } from "@/api/handlers/case-law/ingestion/pipeline/stored-raw";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import { readStoredRawListing } from "@/api/lib/legal-search/ingestion-types";
import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@/api/lib/legal-search/source-raw-envelope";

/** A detail page is bounded independently of the corpus's larger PDF budget. */
export const COLLECTION_DETAIL_MAX_BYTES = 1024 * 1024;

type CollectionIdentity = Pick<
  CzNsSbirkaDocumentIdentity,
  "caseNumber" | "ecli" | "court" | "decisionDate" | "decisionType"
>;

type CollectionBodyReadOptions = {
  tx: CaseLawPublicReadTransaction;
  decisionId: SafeId<"caseLawDecision">;
  identity: CollectionIdentity;
};

/** No publisher access: only the exact owned detail admitted by the public view. */
export const readCollectionBody = async ({
  tx,
  decisionId,
  identity,
}: CollectionBodyReadOptions) => {
  const [attachment] = await tx
    .select({
      postId: caseLawCollectionBodies.collectionDocumentId,
      sourceUrl: caseLawCollectionBodies.sourceUrl,
      retrievedAt: caseLawCollectionBodies.retrievedAt,
      key: caseLawCollectionBodies.detailRawS3Key,
      contentType: caseLawCollectionBodies.detailRawContentType,
      source: {
        id: caseLawSources.id,
        name: caseLawSources.name,
        adapterKey: caseLawSources.adapterKey,
        descriptor: caseLawSources.descriptor,
      },
    })
    .from(caseLawCollectionBodies)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, caseLawCollectionBodies.collectionSourceId),
    )
    .where(eq(caseLawCollectionBodies.hostDecisionId, decisionId))
    .orderBy(
      asc(caseLawCollectionBodies.collectionSourceId),
      asc(caseLawCollectionBodies.collectionDocumentId),
    )
    .limit(1);
  if (attachment === undefined) {
    return { status: "absent" } as const;
  }
  if (
    attachment.key === null ||
    attachment.sourceUrl === null ||
    attachment.contentType !== SOURCE_RAW_ENVELOPE_CONTENT_TYPE
  ) {
    return { status: "unavailable" } as const;
  }
  const raw = await readStoredRawFromS3(
    attachment.key,
    COLLECTION_DETAIL_MAX_BYTES,
  );
  if (Result.isError(raw) || raw.value === null) {
    return { status: "unavailable" } as const;
  }
  const bytes = raw.value;
  const rawSha256 = sha256Hex(bytes);
  if (
    bytes.byteLength > COLLECTION_DETAIL_MAX_BYTES ||
    !attachment.key.endsWith(`/payloads/${rawSha256}`)
  ) {
    return { status: "unavailable" } as const;
  }
  const listing = readStoredRawListing({
    stored: {
      raw: bytes,
      contentType: attachment.contentType,
      sourceDocumentId: attachment.postId,
    },
    part: "listing",
    identityOf: (row) =>
      typeof row["postId"] === "string" ? row["postId"] : undefined,
  });
  if (listing.type === "rejected") {
    return { status: "unavailable" } as const;
  }
  const detail = listing.parts.detail;
  if (detail === undefined) {
    return { status: "unavailable" } as const;
  }
  const evidence = {
    sourceId: attachment.source.id,
    sourceDocumentId: attachment.postId,
    sourceUrl: attachment.sourceUrl,
    retrievedAt: attachment.retrievedAt.toISOString(),
    rawKey: attachment.key,
    rawSha256,
  };
  const page = readCzNsSbirkaPage(detail);
  if (page.textHtml === undefined) {
    return { status: "empty", evidence } as const;
  }
  const parsed = parseCzNsSbirkaText(page.textHtml, {
    ...identity,
    postId: attachment.postId,
    sourceUrl: attachment.sourceUrl,
    keywords: page.keywordChips,
    statutes: [],
  });
  if (Result.isError(parsed)) {
    return { status: "empty", evidence } as const;
  }
  return {
    status: "present",
    ...parsed.value,
    bodySource: {
      textSource: "collection",
      sourceUrl: attachment.sourceUrl,
      retrievedAt: attachment.retrievedAt.toISOString(),
      source: {
        id: attachment.source.id,
        name: attachment.source.name,
        adapterKey: attachment.source.adapterKey,
        allowsDerivedAi: allowsDerivedAi(attachment.source.descriptor),
      },
    } satisfies DecisionBodySource,
  } as const;
};
