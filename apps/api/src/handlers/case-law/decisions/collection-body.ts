import { panic, Result } from "better-result";
import { asc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  COLLECTION_PUBLICATION_CONTRIBUTION,
  COLLECTION_PUBLICATION_PROJECTION_MAX,
} from "@stll/api-contract/case-law-body-source";
import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/ingestion-constants";
import { readStoredRawListing } from "@stll/case-law-ingestion-core/ingestion-types";
import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@stll/case-law-ingestion-core/source-raw-envelope";
import {
  parseCzNsSbirkaText,
  readCzNsSbirkaPage,
} from "@stll/case-law-parsers/cz-ns-sbirka";
import type { CzNsSbirkaDocumentIdentity } from "@stll/case-law-parsers/cz-ns-sbirka";
import { hasUsableAst } from "@stll/legal-ast/document-ast";
import { sha256Hex } from "@stll/sha256/bun";

import { caseLawCollectionBodies, caseLawSources } from "@/api/db/schema";
import { readStoredRawFromS3 } from "@/api/handlers/case-law/ingestion/pipeline/stored-raw";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readCappedByGroup } from "@/api/lib/db/read-bounded";
import { decodeCollectionDocumentBody } from "@/api/lib/legal-search/collection-document-part";
import { collectionDocumentPartReadSchema } from "@/api/lib/legal-search/collection-document-part-read";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import { heldDecisionAttachmentForAdapter } from "@/api/lib/legal-search/held-decision-attachment";
import { requestBoundedTimeoutMs } from "@/api/lib/load/request-latency-budget";

import {
  collectionBodySourceOf,
  publicationProvenanceOf,
} from "./collection-body-provenance";
import {
  composeCollectionDocument,
  planCollectionDocument,
} from "./compose-collection-document";
import type {
  CollectionDocumentPlan,
  CollectionPublication,
  LoadedCollectionPublication,
} from "./compose-collection-document";

const COLLECTION_DETAIL_MAX_BYTES = 1024 * 1024;
const COLLECTION_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
const COLLECTION_READ_MAX_BYTES = 32 * 1024 * 1024;
const COLLECTION_READ_TIMEOUT_MS = 30_000;
export const COLLECTION_EMPTY_EVIDENCE_KIND = {
  SNAPSHOT: "snapshot-empty",
  PUBLISHER_PAGE: "publisher-page-empty",
} as const;

type CollectionIdentity = Pick<
  CzNsSbirkaDocumentIdentity,
  "caseNumber" | "ecli" | "court" | "decisionDate" | "decisionType"
>;
type CollectionPublicationReadOptions = {
  tx: CaseLawPublicReadTransaction;
  decisionId: SafeId<"caseLawDecision">;
};

/** Metadata is bounded; the window count preserves the exact omitted-record total. */
export const readCollectionPublications = async ({
  tx,
  decisionId,
}: CollectionPublicationReadOptions) => {
  const query = tx
    .select({
      postId: caseLawCollectionBodies.collectionDocumentId,
      sourceUrl: caseLawCollectionBodies.sourceUrl,
      retrievedAt: caseLawCollectionBodies.retrievedAt,
      key: caseLawCollectionBodies.detailRawS3Key,
      contentType: caseLawCollectionBodies.detailRawContentType,
      documentPart: caseLawCollectionBodies.documentPart,
      documentBodyS3Key: caseLawCollectionBodies.documentBodyS3Key,
      documentBodySha256: caseLawCollectionBodies.documentBodySha256,
      origin: caseLawCollectionBodies.origin,
      totalCount: sql<number>`count(*) OVER ()`.mapWith(Number),
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
      sql`CASE WHEN ${caseLawCollectionBodies.origin} = 'canonical-own-row' THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${caseLawCollectionBodies.documentPart}->>'extent' = 'complete' THEN 0 ELSE 1 END`,
      asc(caseLawCollectionBodies.collectionSourceId),
      asc(caseLawCollectionBodies.collectionDocumentId),
    );
  // The leading publications; their exact total is counted apart, so a
  // truncated projection still says how many it omits.
  const { rows } = await readCappedByGroup(query, {
    cap: COLLECTION_PUBLICATION_PROJECTION_MAX,
    readRows: async (limited) => await limited,
    groupKeyOf: () => "publications",
  });
  return { rows, totalCount: rows.at(0)?.totalCount ?? 0 };
};

type CollectionSelection = Awaited<
  ReturnType<typeof readCollectionPublications>
>;
type StoredCollectionPublication = CollectionSelection["rows"][number];

const collectionPublicationOf = (
  row: StoredCollectionPublication,
): CollectionPublication | null => {
  if (row.sourceUrl === null) {
    return null;
  }
  const part = v.safeParse(
    collectionDocumentPartReadSchema,
    row.documentPart ?? { extent: "unclassified", keywords: [] },
  );
  if (!part.success) {
    return null;
  }
  return {
    sourceDocumentId: row.postId,
    sourceUrl: row.sourceUrl,
    retrievedAt: row.retrievedAt.toISOString(),
    source: {
      id: row.source.id,
      name: row.source.name,
      adapterKey: row.source.adapterKey,
      allowsDerivedAi: allowsDerivedAi(row.source.descriptor),
    },
    documentPart: part.output,
  };
};

const publicationKey = ({ source, sourceDocumentId }: CollectionPublication) =>
  JSON.stringify([source.id, sourceDocumentId]);

const planRetainedCollectionSnapshots = (rows: CollectionSelection["rows"]) =>
  planCollectionDocument(
    rows.flatMap((row) => {
      if (row.documentPart === null) {
        return [];
      }
      const publication = collectionPublicationOf(row);
      return publication === null ? [] : [publication];
    }),
  );

type CanonicalCollectionContextOptions = {
  selection: CollectionSelection;
  source: StoredCollectionPublication["source"] | null;
  sourceUrl: string | null;
  sourceObservedAt: Date | null;
};

export const canonicalCollectionBodyContextOf = ({
  selection,
  source,
  sourceUrl,
  sourceObservedAt,
}: CanonicalCollectionContextOptions) => {
  const self = selection.rows.find(
    ({ origin }) => origin === "canonical-own-row",
  );
  if (
    self === undefined &&
    (source === null ||
      heldDecisionAttachmentForAdapter(source.adapterKey) === null)
  ) {
    return { status: "host" } as const;
  }
  let publication = self === undefined ? null : collectionPublicationOf(self);
  if (self === undefined && source !== null && sourceUrl !== null) {
    publication = {
      source: {
        id: source.id,
        name: source.name,
        adapterKey: source.adapterKey,
        allowsDerivedAi: allowsDerivedAi(source.descriptor),
      },
      sourceDocumentId: null,
      sourceUrl,
      retrievedAt: sourceObservedAt?.toISOString() ?? null,
      documentPart: { extent: "unclassified", keywords: [] },
    };
  }
  if (publication === null) {
    return { status: "unavailable" } as const;
  }
  const related = selection.rows.flatMap((row) => {
    const record = collectionPublicationOf(row);
    return record === null
      ? []
      : [
          publicationProvenanceOf(
            record,
            COLLECTION_PUBLICATION_CONTRIBUTION.RELATED,
          ),
        ];
  });
  const snapshotPlan = planRetainedCollectionSnapshots(selection.rows);
  const hasStructuredEdition =
    snapshotPlan !== null && snapshotPlan.extent !== "unclassified";
  const preferredBody =
    publication.documentPart.extent !== "complete" && hasStructuredEdition
      ? "collection"
      : "canonical";
  return {
    status: "collection",
    publication,
    preferredBody,
    selfExtent: self?.documentPart?.extent ?? null,
    bodySource: collectionBodySourceOf({
      primary: publicationProvenanceOf(
        publication,
        COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
      ),
      publications: related,
      totalCount: selection.totalCount + (self === undefined ? 1 : 0),
    }),
  } as const;
};

type CollectionBodyReadOptions = CollectionPublicationReadOptions & {
  identity: CollectionIdentity;
  selection?: CollectionSelection;
};

type LoadedCollectionSnapshot = LoadedCollectionPublication & {
  rawKey: string;
  rawSha256: string;
};

type LoadCollectionSnapshotsOptions = {
  plan: CollectionDocumentPlan;
  rows: CollectionSelection["rows"];
};

/** One shared deadline and byte budget covers all exact-owned selected snapshots. */
const loadCollectionSnapshots = async ({
  plan,
  rows,
}: LoadCollectionSnapshotsOptions) => {
  const signal = AbortSignal.timeout(
    requestBoundedTimeoutMs(COLLECTION_READ_TIMEOUT_MS),
  );
  const loaded: LoadedCollectionSnapshot[] = [];
  let remainingBytes = COLLECTION_READ_MAX_BYTES;
  for (const publication of plan.publications) {
    const row =
      rows.find(
        (candidate) =>
          candidate.source.id === publication.source.id &&
          candidate.postId === publication.sourceDocumentId,
      ) ?? panic("Lost a selected collection publication");
    if (
      row.documentBodyS3Key === null ||
      row.documentBodySha256 === null ||
      remainingBytes === 0
    ) {
      return { status: "unavailable" } as const;
    }
    const raw = await readStoredRawFromS3(
      row.documentBodyS3Key,
      Math.min(COLLECTION_SNAPSHOT_MAX_BYTES, remainingBytes),
      signal,
    );
    if (
      Result.isError(raw) ||
      raw.value === null ||
      sha256Hex(raw.value) !== row.documentBodySha256
    ) {
      return { status: "unavailable" } as const;
    }
    remainingBytes -= raw.value.byteLength;
    const decoded = decodeCollectionDocumentBody(raw.value);
    if (Result.isError(decoded)) {
      return { status: "unavailable" } as const;
    }
    loaded.push({
      publication,
      payload: decoded.value,
      rawKey: row.documentBodyS3Key,
      rawSha256: row.documentBodySha256,
    });
  }
  return { status: "loaded", publications: loaded } as const;
};

/** Only retained, exact-owned objects are read; no publisher access or writes. */
export const readCollectionBody = async ({
  tx,
  decisionId,
  identity,
  selection,
}: CollectionBodyReadOptions) => {
  const selected =
    selection ?? (await readCollectionPublications({ tx, decisionId }));
  if (selected.rows.length === 0) {
    return { status: "absent" } as const;
  }
  for (const row of selected.rows) {
    if (
      row.documentPart !== null &&
      !v.safeParse(collectionDocumentPartReadSchema, row.documentPart).success
    ) {
      return { status: "unavailable" } as const;
    }
  }
  const publications = selected.rows.flatMap((row) => {
    const publication = collectionPublicationOf(row);
    return publication === null ? [] : [publication];
  });
  const plan = planRetainedCollectionSnapshots(selected.rows);
  if (plan !== null) {
    const loaded = await loadCollectionSnapshots({ plan, rows: selected.rows });
    if (loaded.status === "unavailable") {
      return loaded;
    }
    const composed = composeCollectionDocument({
      decisionId,
      identity: {
        caseNumber: identity.caseNumber,
        court: identity.court,
        ecli: identity.ecli ?? null,
        decisionDate: identity.decisionDate ?? null,
        decisionType: identity.decisionType ?? null,
      },
      publications: loaded.publications,
    });
    if (Result.isError(composed)) {
      return { status: "unavailable" } as const;
    }
    const primary = composed.value.plan.publications[0];
    const contributing = new Set(
      composed.value.plan.publications.map(publicationKey),
    );
    const contextLayouts = new Map(
      composed.value.contextLayouts.map(
        ({ publication, sha256, representation }) => [
          publicationKey(publication),
          { sha256, representation },
        ],
      ),
    );
    const bodySource = collectionBodySourceOf({
      primary: publicationProvenanceOf(
        primary,
        COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
        contextLayouts.get(publicationKey(primary)),
      ),
      publications: publications.map((publication) =>
        publicationProvenanceOf(
          publication,
          contributing.has(publicationKey(publication))
            ? COLLECTION_PUBLICATION_CONTRIBUTION.BODY
            : COLLECTION_PUBLICATION_CONTRIBUTION.RELATED,
          contextLayouts.get(publicationKey(publication)),
        ),
      ),
      totalCount: selected.totalCount,
    });
    const { payload } = composed.value;
    const documentAst = hasUsableAst(payload.ast) ? payload.ast : null;
    const fulltext = payload.text?.trim()
      ? payload.text
      : (documentAst?.blocks.map(({ plainText }) => plainText).join("\n\n") ??
        payload.sections?.map(({ text }) => text).join("\n\n") ??
        "");
    if (documentAst === null && fulltext.trim().length === 0) {
      const row =
        selected.rows.find(
          (candidate) =>
            candidate.source.id === primary.source.id &&
            candidate.postId === primary.sourceDocumentId,
        ) ?? panic("Lost the primary collection publication");
      const snapshot =
        loaded.publications.find(
          ({ publication }) =>
            publicationKey(publication) === publicationKey(primary),
        ) ?? panic("Lost the primary retained snapshot");
      return {
        status: "empty",
        evidence: {
          kind: COLLECTION_EMPTY_EVIDENCE_KIND.SNAPSHOT,
          sourceId: row.source.id,
          sourceDocumentId: row.postId,
          sourceUrl: primary.sourceUrl,
          retrievedAt: primary.retrievedAt,
          rawKey: snapshot.rawKey,
          rawSha256: snapshot.rawSha256,
        },
      } as const;
    }
    return { status: "present", documentAst, fulltext, bodySource } as const;
  }
  const legacy = selected.rows.find(
    ({ source }) => source.adapterKey === ADAPTER_KEYS.CZ_NS_SBIRKA,
  );
  return legacy === undefined
    ? ({ status: "unavailable" } as const)
    : await readLegacyCollectionBody(legacy, identity, selected);
};

const readLegacyCollectionBody = async (
  attachment: StoredCollectionPublication,
  identity: CollectionIdentity,
  selection: CollectionSelection,
) => {
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
  const detail = listing.parts["detail"];
  if (detail === undefined) {
    return { status: "unavailable" } as const;
  }
  const evidence = {
    kind: COLLECTION_EMPTY_EVIDENCE_KIND.PUBLISHER_PAGE,
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
    bodySource: collectionBodySourceOf({
      primary: publicationProvenanceOf(
        {
          sourceDocumentId: attachment.postId,
          sourceUrl: attachment.sourceUrl,
          retrievedAt: attachment.retrievedAt.toISOString(),
          source: {
            id: attachment.source.id,
            name: attachment.source.name,
            adapterKey: attachment.source.adapterKey,
            allowsDerivedAi: allowsDerivedAi(attachment.source.descriptor),
          },
          documentPart: { extent: "unclassified", keywords: [] },
        },
        COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
      ),
      publications: selection.rows.flatMap((row) => {
        const publication = collectionPublicationOf(row);
        return publication === null
          ? []
          : [
              publicationProvenanceOf(
                publication,
                COLLECTION_PUBLICATION_CONTRIBUTION.RELATED,
              ),
            ];
      }),
      totalCount: selection.totalCount,
    }),
  } as const;
};
