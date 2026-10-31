import { panic } from "better-result";
import { and, eq, lte, or, sql } from "drizzle-orm";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";
import { chunk } from "@stll/concurrency/chunk";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  publishedLegislationDocumentIn,
  redistributableLegislationVersionFor,
} from "@/api/lib/legal-search/legislation-redistribution";
import {
  legislationVersionRef,
  opensOn,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  readVersionBlocks,
  versionAstColumns,
} from "@/api/lib/legal-search/legislation-version-blocks";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";

type MatterLinkProvisionRequest = {
  statuteId: string;
  provisionId: string;
  version: string;
  jurisdiction: string;
};

type MatterLinkProvisionResolution =
  | {
      status: "available";
      item: MatterLinkProvisionRequest;
      documentId: SafeId<"legislationDocument">;
    }
  | {
      status: "rejected";
      item: MatterLinkProvisionRequest;
      reason: "not_found" | "out_of_jurisdiction" | "ambiguous_version";
    };

const versionKey = (
  item: Pick<
    MatterLinkProvisionRequest,
    "statuteId" | "jurisdiction" | "version"
  >,
) => JSON.stringify([item.statuteId, item.jurisdiction, item.version]);

type ResolveMatterLinkProvisionsOptions = {
  items: readonly MatterLinkProvisionRequest[];
  legislationDb: LegislationReadDb;
};

/** Resolve corpus references before opening the tenant mutation transaction. */
export const resolveMatterLinkProvisions = async ({
  items,
  legislationDb,
}: ResolveMatterLinkProvisionsOptions): Promise<
  MatterLinkProvisionResolution[]
> => {
  const requests = [
    ...new Map(
      items.map((item) => [
        JSON.stringify([
          item.statuteId,
          item.provisionId,
          item.version,
          item.jurisdiction,
        ]),
        item,
      ]),
    ).values(),
  ];
  const admitted = new Set<string>(PUBLIC_LEGISLATION_COUNTRIES);
  const candidates = requests.filter((item) => admitted.has(item.jurisdiction));
  if (candidates.length === 0) {
    return requests.map((item) => ({
      status: "rejected",
      item,
      reason: "out_of_jurisdiction",
    }));
  }

  const versions = [
    ...new Map(candidates.map((item) => [versionKey(item), item])).values(),
  ];
  const requestedAnchors = [
    ...new Set(candidates.map(({ provisionId }) => provisionId)),
  ];

  const documents = await legislationDb(async (tx) => {
    // Two matches prove ambiguity; additional languages or publishers cannot
    // increase the metadata transferred for a requested version.
    const ranked = tx
      .select({
        id: legislationDocuments.id,
        eli: legislationDocuments.eli,
        country: legislationDocuments.country,
        version: legislationDocuments.versionValidFrom,
        rank: sql<number>`row_number() OVER (
        PARTITION BY ${legislationDocuments.eli}, ${legislationDocuments.country}, ${legislationDocuments.versionValidFrom}
        ORDER BY ${legislationDocuments.id}
      )`.as("version_rank"),
      })
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(
        and(
          publishedLegislationDocumentIn(PUBLIC_LEGISLATION_COUNTRIES),
          or(
            ...versions.map((item) =>
              and(
                eq(legislationDocuments.eli, item.statuteId),
                eq(legislationDocuments.country, item.jurisdiction),
                opensOn(
                  legislationVersionRef(legislationDocuments),
                  sql`${item.version}::date`,
                ),
              ),
            ),
          ),
        ),
      )
      .as("matter_link_versions");
    const read = await readBounded(
      tx
        .select({
          id: ranked.id,
          eli: ranked.eli,
          country: ranked.country,
          version: ranked.version,
        })
        .from(ranked)
        .where(lte(ranked.rank, 2)),
      versions.length * 2,
    );
    if (read.type === "overflow") {
      return panic(
        "A windowed matter-link version read exceeded its own bound",
      );
    }
    return read.rows;
  });

  const documentGroups = Map.groupBy(documents, (row) =>
    versionKey({
      statuteId: row.eli,
      jurisdiction: row.country,
      version: String(row.version),
    }),
  );
  const uniqueDocuments = [...documentGroups.values()].flatMap((rows) =>
    rows.length === 1 ? rows : [],
  );
  const anchorsByDocument = new Map(
    documents.map((row) => [row.id, new Set<string>()]),
  );
  const requestedAnchorSet = new Set(requestedAnchors);
  // Legacy ASTs normalize duplicate anchors in the canonical reader. Reading
  // raw JSON in SQL would disagree with the anchors a prior reader returned.
  // Whole payloads cannot be range-read, so fetch each version separately,
  // keep at most two ASTs in flight, and retain only the requested anchors.
  for (const batch of chunk(uniqueDocuments, 2)) {
    await Promise.all(
      batch.map(async (row) => {
        const read = await legislationDb(
          async (tx) =>
            await readBounded(
              tx
                .select(versionAstColumns)
                .from(legislationDocuments)
                .where(
                  and(
                    eq(legislationDocuments.id, row.id),
                    redistributableLegislationVersionFor("search"),
                    opensOn(
                      legislationVersionRef(legislationDocuments),
                      sql`${row.version}::date`,
                    ),
                  ),
                ),
              1,
            ),
        );
        if (read.type === "overflow") {
          return panic("A primary-key AST read returned more than one version");
        }
        const version = read.rows.at(0);
        if (version === undefined) {
          return;
        }
        const blocks = await readVersionBlocks({
          row: version,
          legislationDb,
          step: "matterLinkProvision.corpusAst",
          surface: "search",
        });
        anchorsByDocument.set(
          row.id,
          new Set(
            blocks.flatMap(({ anchorId }) =>
              requestedAnchorSet.has(anchorId) ? [anchorId] : [],
            ),
          ),
        );
      }),
    );
  }

  return requests.map((item): MatterLinkProvisionResolution => {
    if (!admitted.has(item.jurisdiction)) {
      return { status: "rejected", item, reason: "out_of_jurisdiction" };
    }
    const rows = documentGroups.get(versionKey(item));
    if (rows === undefined) {
      return { status: "rejected", item, reason: "not_found" };
    }
    if (rows.length > 1) {
      return { status: "rejected", item, reason: "ambiguous_version" };
    }
    const document = rows.at(0) ?? panic("A version group cannot be empty");
    const availableAnchors =
      anchorsByDocument.get(document.id) ??
      panic("A resolved version has no anchor classification");
    return availableAnchors.has(item.provisionId)
      ? { status: "available", item, documentId: document.id }
      : { status: "rejected", item, reason: "not_found" };
  });
};
