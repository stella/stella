import { queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import { publicKnowledgeKeys } from "@/features/knowledge/public/public-knowledge-keys";
import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { unwrapPublicKnowledge } from "@/lib/knowledge/public-knowledge-api";
import type { PublicKnowledgeData } from "@/lib/knowledge/public-knowledge-api";

export { publicKnowledgeKeys } from "@/features/knowledge/public/public-knowledge-keys";

/** The ready-made playbooks anyone may start from. */
export const catalogueStartersOptions = () =>
  queryOptions({
    queryKey: publicKnowledgeKeys.playbooks.starters(),
    queryFn: async ({ signal }) => {
      const list = unwrapPublicKnowledge(
        await api.public.knowledge["playbook-starters"].get({
          fetch: { signal },
        }),
        "list starter playbooks",
      );
      // Only an item can be missing; the list route always answers a list.
      return list === null
        ? panic("The starter playbook list answered not found.")
        : list.items;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

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
