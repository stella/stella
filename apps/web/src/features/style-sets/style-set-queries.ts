import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import type { StyleSetEditorSettings } from "@/features/style-sets/style-set-editor-types";
import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { toAPIError, unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

const STYLE_SETS_PAGE_SIZE = 100;

type StyleSetEditorKey = {
  organizationId: string;
  styleSetId: string;
};

type StyleSetPreviewBody = Parameters<
  (typeof api)["style-sets"]["editor"]["preview"]["post"]
>[0];

export type StyleSetPreviewContent = StyleSetPreviewBody["content"];

export type StyleSetPreviewSource =
  | { type: "stella" }
  | { type: "saved"; styleSetId: string };

type StyleSetPreviewOptions = {
  organizationId: string;
  source: StyleSetPreviewSource;
  settings: StyleSetEditorSettings;
  content: StyleSetPreviewContent;
};

export const styleSetsKeys = {
  all: (organizationId: string) => ["style-sets", organizationId],
  list: (organizationId: string) => [
    ...styleSetsKeys.all(organizationId),
    "list",
  ],
  editor: ({ organizationId, styleSetId }: StyleSetEditorKey) => [
    ...styleSetsKeys.all(organizationId),
    "editor",
    styleSetId,
  ],
  stellaEditor: (organizationId: string) => [
    ...styleSetsKeys.all(organizationId),
    "editor",
    "stella",
  ],
  preview: ({
    organizationId,
    source,
    settings,
    content,
  }: StyleSetPreviewOptions) => [
    ...styleSetsKeys.all(organizationId),
    "preview",
    source,
    settings,
    content,
  ],
};

const requirePreviewBuffer = (data: unknown): ArrayBuffer => {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  return panic("Style set preview returned a non-binary response");
};

export const styleSetPreviewOptions = (options: StyleSetPreviewOptions) =>
  queryOptions({
    queryKey: styleSetsKeys.preview(options),
    queryFn: async ({ signal }) => {
      const source = options.source;
      const response =
        source.type === "stella"
          ? await api["style-sets"].editor.preview.post(
              {
                type: "stella",
                settings: options.settings,
                content: options.content,
              },
              { fetch: { signal } },
            )
          : await api["style-sets"].editor.preview.post(
              {
                type: "saved",
                styleSetId: toSafeId<"styleSet">(source.styleSetId),
                settings: options.settings,
                content: options.content,
              },
              { fetch: { signal } },
            );
      if (response.error) {
        throw toAPIError(response.error);
      }
      return requirePreviewBuffer(response.data);
    },
    placeholderData: keepPreviousData,
    staleTime: STALE_TIME.FIVE.MINUTES,
    gcTime: STALE_TIME.FIVE.MINUTES,
  });

export const styleSetsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: styleSetsKeys.list(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api["style-sets"].get({
        query: { limit: STYLE_SETS_PAGE_SIZE },
        fetch: { signal },
      });
      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const styleSetEditorOptions = ({
  organizationId,
  styleSetId,
}: StyleSetEditorKey) =>
  queryOptions({
    queryKey: styleSetsKeys.editor({ organizationId, styleSetId }),
    queryFn: async ({ signal }) => {
      const response = await api["style-sets"]({
        styleSetId: toSafeId<"styleSet">(styleSetId),
      }).editor.get({ fetch: { signal } });
      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const stellaStyleEditorOptions = (organizationId: string) =>
  queryOptions({
    queryKey: styleSetsKeys.stellaEditor(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api["style-sets"].editor.stella.get({
        fetch: { signal },
      });
      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
