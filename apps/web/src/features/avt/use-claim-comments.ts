import { useRef } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type {
  AnnotationVisibility,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import {
  applyChange,
  pendingRows,
  rowsOfSame,
} from "@/components/legal-reader/annotations/use-reader-annotations";
import { claimCommentsOptions } from "@/features/avt/claim-comments-query";
import type { VerificationClaim } from "@/features/avt/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

type ClaimCommentsScope = {
  claim: Pick<VerificationClaim, "anchor" | "id" | "text">;
  runId: string;
  workspaceId: string;
};

/** Only a comment's words and visibility change on a claim. */
export type ClaimCommentChange = Extract<
  UpdateAnnotationInput,
  { change: "body" | "visibility" }
>;

export type ClaimComments = {
  /** False outside a signed-in session: nothing to read or write as. */
  available: boolean;
  comments: readonly ReaderAnnotation[];
  create: (body: string, visibility: AnnotationVisibility) => unknown;
  remove: (id: string) => unknown;
  update: (change: ClaimCommentChange) => unknown;
};

/** The block a claim's comment is anchored on, as the server stores it. */
const claimAnchorId = (anchor: VerificationClaim["anchor"]): string =>
  anchor.type === "docx-block"
    ? anchor.blockId
    : `page-${String(anchor.pageNumber)}`;

/**
 * The comments on one verification claim, with the reader's ways to change
 * them. The same rows, optimistic updates and rollback as the case-law
 * reader's comments (`useReaderAnnotations`), addressed through the matter's
 * verification routes: every change lands in the cache at once and is then
 * refetched, because the server knows what a colleague shared meanwhile.
 */
export const useClaimComments = ({
  claim,
  runId,
  workspaceId,
}: ClaimCommentsScope): ClaimComments => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const pendingSequence = useRef(0);
  const options = claimCommentsOptions({
    claimId: claim.id,
    runId,
    viewer: {
      organizationId: user?.activeOrganizationId ?? "",
      userId: user?.id ?? "",
    },
    workspaceId,
  });
  const queryKey = options.queryKey;
  const view = useQueryView(useQuery({ ...options, enabled: user !== null }));
  useQueryViewError(view);
  const comments = view.type === "items" ? view.items : [];
  const commentRoutes = () =>
    api.lists({ workspaceId: toSafeId<"workspace">(workspaceId) })[
      "claim-comments"
    ];
  const oneComment = (id: string) =>
    commentRoutes()({ annotationId: toSafeId<"legalReaderAnnotation">(id) });

  const patchCache = async (
    patch: (rows: readonly ReaderAnnotation[]) => ReaderAnnotation[],
  ): Promise<{ previous: ReaderAnnotation[] | undefined }> => {
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData(queryKey);
    queryClient.setQueryData(queryKey, (rows) => patch(optionalArray(rows)));
    return { previous };
  };

  const settle = {
    onError: (
      error: unknown,
      _input: unknown,
      context: { previous: ReaderAnnotation[] | undefined } | undefined,
    ) => {
      if (context !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      getAnalytics().captureError(error);
      notifyUserError(error, t("errors.actionFailed"));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  };

  const create = useMutation({
    mutationFn: async ({
      body,
      visibility,
    }: {
      body: string;
      visibility: AnnotationVisibility;
    }) =>
      unwrapEden(
        await commentRoutes().post({
          body,
          claimId: toSafeId<"legalListClaim">(claim.id),
          runId: toSafeId<"legalListVerificationRun">(runId),
          visibility,
        }),
      ),
    onMutate: async ({ body, visibility }) => {
      // Tells pending comments apart; only ever advanced on a submit.
      pendingSequence.current += 1;
      const stamp = pendingSequence.current;
      return await patchCache((rows) => [
        ...rows,
        ...pendingRows({
          author: {
            id: user?.id ?? "",
            image: user?.image ?? null,
            name: user?.name ?? null,
          },
          input: {
            body,
            kind: "comment",
            spans: [
              {
                blockAnchorId: claimAnchorId(claim.anchor),
                endOffset: claim.anchor.end,
                quote: claim.text,
                startOffset: claim.anchor.start,
              },
            ],
            visibility,
          },
          stamp,
        }),
      ]);
    },
    ...settle,
  });

  const update = useMutation({
    mutationFn: async ({ id, ...change }: ClaimCommentChange) =>
      unwrapEden(await oneComment(id).patch(change)),
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
    mutationFn: async (id: string) => unwrapEden(await oneComment(id).delete()),
    onMutate: async (id) =>
      await patchCache((rows) => {
        const touched = rowsOfSame(rows, id);
        return rows.filter((row) => !touched(row));
      }),
    ...settle,
  });

  return {
    available: user !== null,
    comments: optionalArray(comments).filter(
      (row) => row.kind === "comment" && row.body !== null,
    ),
    create: (body, visibility) => create.mutateAsync({ body, visibility }),
    remove: remove.mutateAsync,
    update: update.mutateAsync,
  };
};
