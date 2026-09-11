import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { mapWithConcurrency } from "@stll/concurrency";
import { stellaToast } from "@stll/ui/toast";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/features/case-law/annotations/annotation-types";
import {
  readGuestAnnotationStore,
  removeGuestAnnotation,
} from "@/features/case-law/annotations/guest-annotation-store.logic";
import {
  decisionAnnotationKeys,
  decisionAnnotationsOptions,
} from "@/features/case-law/queries/annotations";
import type { DecisionAnnotation } from "@/features/case-law/queries/annotations";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useSessionStorage } from "@/hooks/use-session-storage";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

/** A mark not yet acknowledged by the server, keyed so it can be told apart. */
const PENDING_ID_PREFIX = "pending:";

/** A mark the server has not stored yet cannot be changed or removed. */
export const isPendingAnnotationId = (id: string): boolean =>
  id.startsWith(PENDING_ID_PREFIX);

/** Tells pending marks apart within one page; only ever advanced on a click. */
let pendingSequence = 0;

/** Guest migration is bounded so signing in never opens a request flood. */
const GUEST_ANNOTATION_MIGRATION_CONCURRENCY = 4;

/**
 * The rows a new mark will have once stored, so the text shows it the moment
 * the reader picks a colour. One row per paragraph, under one group when
 * there are several, as the server lays them out.
 */
const pendingRows = ({
  author,
  input,
  stamp,
}: {
  author: { id: string; image: string | null; name: string | null };
  input: CreateAnnotationInput;
  stamp: number;
}): DecisionAnnotation[] => {
  const groupId =
    input.spans.length > 1 ? `${PENDING_ID_PREFIX}${stamp}` : null;
  const now = new Date();
  return input.spans.map((span, index) => ({
    authorId: author.id,
    authorImage: author.image,
    authorName: author.name ?? "",
    blockAnchorId: span.blockAnchorId,
    body: input.kind === "comment" && index === 0 ? input.body : null,
    color: input.kind === "highlight" ? input.color : null,
    createdAt: now,
    endOffset: span.endOffset,
    groupId,
    id: toSafeId<"caseLawDecisionAnnotation">(
      `${PENDING_ID_PREFIX}${stamp}:${index}`,
    ),
    kind: input.kind,
    mine: true,
    quote: span.quote,
    startOffset: span.startOffset,
    style: input.kind === "highlight" ? input.style : null,
    updatedAt: now,
    visibility: input.visibility,
  }));
};

/** The rows one change reaches: the whole group of the named row. */
const rowsOfSame = (
  rows: readonly DecisionAnnotation[],
  id: string,
): ((row: DecisionAnnotation) => boolean) => {
  const target = rows.find((row) => row.id === id);
  return (row) =>
    row.id === id ||
    (target?.groupId !== null &&
      target !== undefined &&
      row.groupId === target.groupId);
};

const applyChange = (
  row: DecisionAnnotation,
  change: UpdateAnnotationInput,
): DecisionAnnotation => {
  switch (change.change) {
    case "body": {
      return row.body === null ? row : { ...row, body: change.body };
    }
    case "color": {
      return { ...row, color: change.color };
    }
    case "style": {
      return { ...row, style: change.style };
    }
    case "visibility": {
      return { ...row, visibility: change.visibility };
    }
    default: {
      change satisfies never;
      return panic(`Unhandled change: ${String(change)}`);
    }
  }
};

/**
 * The reader's marks on a decision, with the three ways to change them.
 * Every change lands in the cache at once so the text answers the reader's
 * hand, then the list is refetched: the server is the one that knows what a
 * colleague shared meanwhile, and a rejected change is rolled back.
 */
export const useDecisionAnnotations = (
  decisionId: SafeId<"caseLawDecision">,
) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const {
    activeOrganizationId,
    id: userId,
    image,
    name,
  } = useAuthenticatedUser();
  const guestStorage = useSessionStorage();
  const key = { activeOrganizationId, decisionId };
  const annotationsQuery = decisionAnnotationsOptions(key);
  const queryKey = annotationsQuery.queryKey;
  const { data } = useQuery(annotationsQuery);

  const patchCache = async (
    patch: (rows: readonly DecisionAnnotation[]) => DecisionAnnotation[],
  ): Promise<{ previous: DecisionAnnotation[] | undefined }> => {
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData(queryKey);
    queryClient.setQueryData(queryKey, (rows) => patch(optionalArray(rows)));
    return { previous };
  };

  const settle = {
    onError: (
      error: unknown,
      _input: unknown,
      context: { previous: DecisionAnnotation[] | undefined } | undefined,
    ) => {
      if (context !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      getAnalytics().captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  };

  const create = useMutation({
    mutationFn: async (input: CreateAnnotationInput) => {
      const response = await api.case
        .decisions({ decisionId })
        .annotations.post(input);
      return unwrapEden(response);
    },
    onMutate: async (input) => {
      pendingSequence += 1;
      const stamp = pendingSequence;
      return await patchCache((rows) => [
        ...rows,
        ...pendingRows({
          author: { id: userId, image: image ?? null, name: name ?? null },
          input,
          stamp,
        }),
      ]);
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
    onMutate: async (input) =>
      await patchCache((rows) => {
        const touched = rowsOfSame(rows, input.id);
        return rows.map((row) =>
          touched(row) ? applyChange(row, input) : row,
        );
      }),
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
    onMutate: async (id) =>
      await patchCache((rows) => {
        const touched = rowsOfSame(rows, id);
        return rows.filter((row) => !touched(row));
      }),
    ...settle,
  });

  useExternalSyncEffect(() => {
    const storage = guestStorage;
    if (storage === null) {
      return;
    }
    const store = readGuestAnnotationStore(storage);
    if (store.items.length === 0) {
      return;
    }
    detached(
      (async () => {
        const results = await mapWithConcurrency({
          items: store.items,
          limit: GUEST_ANNOTATION_MIGRATION_CONCURRENCY,
          operation: async (item) => {
            const migrated = await Result.tryPromise(async () => {
              const response = await api.case
                .decisions({
                  decisionId: toSafeId<"caseLawDecision">(item.decisionId),
                })
                .annotations.post({
                  ...item.input,
                  requestId: toSafeId<"caseLawDecisionAnnotation">(
                    item.requestId,
                  ),
                });
              unwrapEden(response);
            });
            if (Result.isError(migrated)) {
              getAnalytics().captureError(migrated.error, {
                operation: "case-law.guest-annotation.migrate",
                type: "detached",
              });
              return false;
            }
            const removed = removeGuestAnnotation(storage, item.requestId);
            if (Result.isError(removed)) {
              getAnalytics().captureError(removed.error, {
                operation: "case-law.guest-annotation.migrate",
                type: "detached",
              });
              return false;
            }
            return true;
          },
        });
        await queryClient.invalidateQueries({
          queryKey: decisionAnnotationKeys.all,
        });
        if (results.some((saved) => !saved)) {
          stellaToast.add({
            title: t("caseLaw.annotations.guestMigrationFailed"),
            type: "error",
          });
          return;
        }
        stellaToast.add({
          title: t("caseLaw.annotations.guestMigrationComplete"),
          type: "success",
        });
      })(),
      "case-law.migrate-guest-annotations",
    );
  }, [guestStorage, queryClient, t]);

  const annotations: readonly DecisionAnnotation[] = optionalArray(data);

  return { annotations, create, remove, update };
};
