import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapPublicLawEden } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

export type ProvisionPreviewKey = {
  /** The provision heading's anchor: what the wording is filed under. */
  anchor: string;
  /** The subdivision the citation named, when it named one. */
  citedAnchor: string | undefined;
  documentId: string;
};

export const provisionPreviewKeys = {
  all: ["statutes", "provision-preview"],
  byAnchor: (key: ProvisionPreviewKey) => [
    ...provisionPreviewKeys.all,
    {
      anchor: key.anchor,
      citedAnchor: key.citedAnchor,
      documentId: key.documentId,
    },
  ],
};

/**
 * The wording one citation points at, without the statute around it.
 *
 * A decision's own provision list already carries the wording of every
 * reference it states, so this reads the few a page could not carry: a
 * reference past that page's ceiling on consolidations, or a provision
 * reached from somewhere other than a decision.
 */
const readProvisionPreview = async (
  key: ProvisionPreviewKey,
  signal: AbortSignal,
) => {
  const response = await api.law
    .statutes({ documentId: toSafeId<"legislationDocument">(key.documentId) })
    .provisions({ anchor: key.anchor })
    .preview.get({
      query:
        key.citedAnchor === undefined ? {} : { citedAnchor: key.citedAnchor },
      fetch: { signal },
    });

  const data = unwrapPublicLawEden(response, "readPublicProvisionPreview");

  return data;
};

/** The wording a preview card renders, however it was read. */
export type ProvisionPreviewData = Awaited<
  ReturnType<typeof readProvisionPreview>
>;

export const provisionPreviewOptions = (key: ProvisionPreviewKey) =>
  queryOptions({
    queryKey: provisionPreviewKeys.byAnchor(key),
    queryFn: async ({ signal }) => await readProvisionPreview(key, signal),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
