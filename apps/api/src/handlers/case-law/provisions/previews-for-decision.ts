import { panic } from "better-result";
import { eq, inArray } from "drizzle-orm";

import type { Block } from "@stll/legal-ast/document-ast";
import { provisionHeadingAnchor } from "@stll/legal-ast/provision-preview";

import { caseLawDecisions, legislationDocuments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import {
  buildProvisionPreview,
  previewVersionColumns,
} from "@/api/lib/legal-search/legislation-provision-preview";
import type { ProvisionPreview } from "@/api/lib/legal-search/legislation-provision-preview";
import {
  readVersionBlocks,
  versionAstColumns,
} from "@/api/lib/legal-search/legislation-version-blocks";
import type { LegislationVersionAstRow } from "@/api/lib/legal-search/legislation-version-blocks";
import { resolveWorksAtDate } from "@/api/lib/legal-search/legislation-works-at-date";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import type { Page } from "@/api/lib/pagination";

const PREVIEWS_READ_STEP = "decisionProvisionPreviews.corpusAst";

/** What a citation row must state for its wording to be readable. */
type CitationRow = {
  anchor: string;
  jurisdiction: string;
  versionValidFrom: string | null;
  workEli: string | null;
};

/** One consolidation to read: a Work addressed at the date a citation names. */
type WorkRequest = {
  key: string;
  country: string;
  eli: string;
  asOf: string;
};

const workRequestKey = ({
  country,
  eli,
  asOf,
}: Omit<WorkRequest, "key">): string => `${country}|${eli}|${asOf}`;

/** Identity of one preview inside a page, stated by the server that built it. */
const previewKeyOf = (
  documentId: SafeId<"legislationDocument">,
  anchor: string,
): string => `${documentId}#${anchor}`;

/**
 * The date a citation's wording is read at: the version the reference itself
 * states, and the decision's own date otherwise. A court applies the text in
 * force when it decided, so that is the truthful fallback.
 */
const citationAsOf = (
  row: CitationRow,
  decisionDate: string | null,
): string | null => row.versionValidFrom ?? decisionDate;

const workRequestsFor = (
  rows: readonly CitationRow[],
  decisionDate: string | null,
): WorkRequest[] => {
  const requests: WorkRequest[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const asOf = citationAsOf(row, decisionDate);
    if (row.workEli === null || asOf === null) {
      continue;
    }

    const key = workRequestKey({
      country: row.jurisdiction,
      eli: row.workEli,
      asOf,
    });
    if (
      seen.has(key) ||
      requests.length >= LIMITS.caseLawProvisionPreviewVersionsMax
    ) {
      continue;
    }

    seen.add(key);
    requests.push({ asOf, country: row.jurisdiction, eli: row.workEli, key });
  }

  return requests;
};

type ResolvedVersion = LegislationVersionAstRow & { language: string };

type ResolvedWorks = {
  versionByWork: Map<string, ResolvedVersion>;
};

/**
 * The consolidation each requested Work had in force on its own date, read
 * with the columns a preview needs. The resolve is the one the public batch
 * read uses, so the wording a preview quotes and the consolidation a link
 * opens are the same row.
 */
const resolveWorkVersions = async (
  requests: readonly WorkRequest[],
  legislationDb: LegislationReadDb,
): Promise<ResolvedWorks> => {
  const versionByWork = new Map<string, ResolvedVersion>();
  if (requests.length === 0) {
    return { versionByWork };
  }

  const { works, versions } = await legislationDb(async (tx) => {
    const idByWork = await resolveWorksAtDate(tx, requests);

    const ids = [...new Set(idByWork.values())];
    if (ids.length === 0) {
      return { works: idByWork, versions: [] };
    }

    return {
      works: idByWork,
      versions: await tx
        .select({ ...previewVersionColumns, ...versionAstColumns })
        .from(legislationDocuments)
        .where(inArray(legislationDocuments.id, ids)),
    };
  });

  const versionById = new Map(versions.map((row) => [row.id, row]));
  for (const [key, id] of works) {
    const version = versionById.get(id);
    if (version !== undefined) {
      versionByWork.set(key, version);
    }
  }

  return { versionByWork };
};

type PreviewsForPageOptions<TRow extends CitationRow> = {
  page: Page<TRow>;
  decisionDate: string | null;
  legislationDb: LegislationReadDb;
};

/** A preview plus the key this page's items reference it by. */
type KeyedProvisionPreview = ProvisionPreview & { key: string };

type PreviewsForPage<TRow extends CitationRow> = Page<
  TRow & { previewKey: string | null }
> & { previews: KeyedProvisionPreview[] };

/**
 * The wording of every provision a page of citations points at, deduplicated
 * by consolidation and anchor: a decision citing one section five times pays
 * for its text once, and a reader hovering any of the five reads it without
 * a further request.
 *
 * `previewKey` is null for a reference this page did not read: a Work the
 * corpus does not hold, a citation with no date to read it at, or one past
 * the per-page ceiling on consolidations. A preview whose `blocks` are empty
 * is the other answer: that consolidation does not carry the anchor.
 */
export const attachDecisionProvisionPreviews = async <
  TRow extends CitationRow,
>({
  page,
  decisionDate,
  legislationDb,
}: PreviewsForPageOptions<TRow>): Promise<PreviewsForPage<TRow>> => {
  const requests = workRequestsFor(page.items, decisionDate);
  const { versionByWork } = await resolveWorkVersions(requests, legislationDb);

  // One read per consolidation, outside any transaction: corpus payloads are
  // whole objects in storage, so a block range is sliced from the version the
  // page needs rather than fetched on its own.
  const versions = [...new Set(versionByWork.values())];
  const blocksByVersion = new Map<ResolvedVersion, readonly Block[]>(
    await Promise.all(
      versions.map(
        async (version) =>
          [
            version,
            await readVersionBlocks({
              row: version,
              legislationDb,
              step: PREVIEWS_READ_STEP,
            }),
          ] as const,
      ),
    ),
  );

  const previewByKey = new Map<string, KeyedProvisionPreview>();
  const items = page.items.map((row) => {
    const asOf = citationAsOf(row, decisionDate);
    if (row.workEli === null || asOf === null) {
      return { ...row, previewKey: null };
    }

    const version = versionByWork.get(
      workRequestKey({ asOf, country: row.jurisdiction, eli: row.workEli }),
    );
    if (version === undefined) {
      return { ...row, previewKey: null };
    }

    const key = previewKeyOf(version.id, row.anchor);
    if (!previewByKey.has(key)) {
      const blocks =
        blocksByVersion.get(version) ??
        panic("A resolved consolidation was not read");

      previewByKey.set(key, {
        key,
        ...buildProvisionPreview({
          version,
          blocks,
          anchor: provisionHeadingAnchor(row.anchor),
          citedAnchor: row.anchor,
        }),
      });
    }

    return { ...row, previewKey: key };
  });

  return { ...page, items, previews: [...previewByKey.values()] };
};

/**
 * The decision's own date, read inside the gate that approved it: the date a
 * citation's wording falls back to when the reference states no version.
 */
export const readDecisionDate = async ({
  id,
  tx,
}: RedistributableDecisionSubject): Promise<string | null> => {
  const [row] = await tx
    .select({ decisionDate: caseLawDecisions.decisionDate })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id))
    .limit(1);

  return row?.decisionDate ?? null;
};
