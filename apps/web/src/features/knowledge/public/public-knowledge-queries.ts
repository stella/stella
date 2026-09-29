import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { unwrapPublicKnowledge } from "@/lib/public-knowledge-api";
import type { PublicKnowledgeData } from "@/lib/public-knowledge-api";

/**
 * Catalogue reads: the same bytes for every visitor, keyed under their own
 * audience so no entry is ever shared with an organization's own Knowledge.
 */
export const publicKnowledgeKeys = {
  all: ["knowledge", "public"] as const,
  templates: {
    all: () => [...publicKnowledgeKeys.all, "templates"] as const,
    catalogue: () =>
      [...publicKnowledgeKeys.templates.all(), "catalogue"] as const,
    detail: (packId: string, templateId: string) =>
      [
        ...publicKnowledgeKeys.templates.all(),
        packId,
        templateId,
        "detail",
      ] as const,
    preview: (packId: string, templateId: string) =>
      [
        ...publicKnowledgeKeys.templates.all(),
        packId,
        templateId,
        "preview",
      ] as const,
  },
};

type PackDetail = PublicKnowledgeData<
  ReturnType<(typeof api.public.knowledge)["template-packs"]>["get"]
>;

/** A catalogue template with the pack it belongs to. */
export type CatalogueTemplate = PackDetail["templates"][number] & {
  pack: PackDetail;
};

/** Every template of every listed pack, with the pack it comes from. */
export const catalogueTemplatesOptions = () =>
  queryOptions({
    queryKey: publicKnowledgeKeys.templates.catalogue(),
    queryFn: async ({ signal }): Promise<CatalogueTemplate[]> => {
      const packs = unwrapPublicKnowledge(
        await api.public.knowledge["template-packs"].get({
          fetch: { signal },
        }),
        "list catalogue packs",
      );
      if (packs === null) {
        return [];
      }
      const details = await Promise.all(
        packs.items.map(async (pack) =>
          unwrapPublicKnowledge(
            await api.public.knowledge["template-packs"]({
              packId: pack.id,
            }).get({ fetch: { signal } }),
            "read catalogue pack",
          ),
        ),
      );
      return details.flatMap((pack) =>
        pack === null
          ? []
          : pack.templates.map((template) => ({ ...template, pack })),
      );
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

/** One catalogue template with its pack, or `null` when it is not listed. */
export const catalogueTemplateOptions = (packId: string, templateId: string) =>
  queryOptions({
    queryKey: publicKnowledgeKeys.templates.detail(packId, templateId),
    queryFn: async ({ signal }): Promise<CatalogueTemplate | null> => {
      // The pack lists its templates in full, so one read names both.
      const pack = unwrapPublicKnowledge(
        await api.public.knowledge["template-packs"]({ packId }).get({
          fetch: { signal },
        }),
        "read catalogue pack",
      );
      const template = pack?.templates.find(({ id }) => id === templateId);
      return pack === null || template === undefined
        ? null
        : { ...template, pack };
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

/** The read-only preview of a catalogue template, or `null` when unlisted. */
export const catalogueTemplatePreviewOptions = (
  packId: string,
  templateId: string,
) =>
  queryOptions({
    queryKey: publicKnowledgeKeys.templates.preview(packId, templateId),
    queryFn: async ({ signal }) =>
      unwrapPublicKnowledge(
        await api.public.knowledge["template-packs"]({ packId })
          .templates({ templateId })
          .preview.get({ fetch: { signal } }),
        "read catalogue template preview",
      ),
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
