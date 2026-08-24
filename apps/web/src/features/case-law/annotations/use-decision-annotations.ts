import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import type { SelectionAnchor } from "@/features/case-law/annotations/selection-anchor";
import {
  decisionAnnotationKeys,
  decisionAnnotationsOptions,
} from "@/features/case-law/queries/annotations";
import type { DecisionAnnotation } from "@/features/case-law/queries/annotations";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

export type AnnotationColor = "yellow" | "green" | "sky" | "violet" | "red";
export type AnnotationStyle =
  | "highlight"
  | "underline"
  | "squiggly"
  | "strikethrough";
export type AnnotationVisibility = "private" | "shared";

export const ANNOTATION_COLORS: readonly AnnotationColor[] = [
  "yellow",
  "green",
  "sky",
  "violet",
  "red",
];

export const ANNOTATION_STYLES: readonly AnnotationStyle[] = [
  "highlight",
  "underline",
  "squiggly",
  "strikethrough",
];

export type CreateAnnotationInput = { spans: SelectionAnchor[] } & (
  | {
      kind: "highlight";
      color: AnnotationColor;
      style: AnnotationStyle;
      visibility: AnnotationVisibility;
    }
  | { kind: "comment"; body: string; visibility: AnnotationVisibility }
);

/** One named change to one annotation. */
export type UpdateAnnotationInput = { id: string } & (
  | { change: "body"; body: string }
  | { change: "color"; color: AnnotationColor }
  | { change: "style"; style: AnnotationStyle }
  | { change: "visibility"; visibility: AnnotationVisibility }
);

/**
 * The reader's marks on a decision, with the three ways to change them. Every
 * change refetches the list rather than patching the cache: the server is
 * the one that knows what a colleague shared meanwhile.
 */
export const useDecisionAnnotations = (
  decisionId: SafeId<"caseLawDecision">,
) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuthenticatedUser();
  const key = { activeOrganizationId, decisionId };
  const { data } = useQuery(decisionAnnotationsOptions(key));

  const settle = {
    onError: (error: unknown) => {
      getAnalytics().captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: decisionAnnotationKeys.forDecision(key),
      });
    },
  };

  const create = useMutation({
    mutationFn: async (input: CreateAnnotationInput) => {
      const response = await api.case
        .decisions({ decisionId })
        .annotations.post(input);
      return unwrapEden(response);
    },
    ...settle,
  });

  const update = useMutation({
    mutationFn: async ({ id, ...change }: UpdateAnnotationInput) => {
      const response = await api.case
        .annotations({
          annotationId: toSafeId<"caseLawDecisionAnnotation">(id),
        })
        .patch(change);
      return unwrapEden(response);
    },
    ...settle,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.case
        .annotations({
          annotationId: toSafeId<"caseLawDecisionAnnotation">(id),
        })
        .delete();
      return unwrapEden(response);
    },
    ...settle,
  });

  const annotations: readonly DecisionAnnotation[] = data ?? [];

  return { annotations, create, remove, update };
};
