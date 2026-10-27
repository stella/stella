import { useQuery } from "@tanstack/react-query";

import { readerPdfPageAnchorId } from "@stll/api-contract/legal-reader-annotations";

import type {
  AnnotationVisibility,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import { useOptimisticAnnotationMutations } from "@/components/legal-reader/annotations/use-optimistic-annotation-mutations";
import { claimCommentsOptions } from "@/features/avt/claim-comments-query";
import type { VerificationClaim } from "@/features/avt/types";
import { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapApiResponse } from "@/lib/errors/api";
import { queryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";

type ClaimCommentsScope = {
  claim: Pick<VerificationClaim, "anchor" | "id" | "text">;
  runId: string;
  workspaceId: string;
};

/** Only a comment's words and visibility change on a claim. */
type ClaimCommentChange = Extract<
  UpdateAnnotationInput,
  { change: "body" | "visibility" }
>;

export type ClaimComments = {
  /** False outside a signed-in session: nothing to read or write as. */
  available: boolean;
  comments: readonly ReaderAnnotation[];
  create: (body: string, visibility: AnnotationVisibility) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  update: (change: ClaimCommentChange) => Promise<unknown>;
};

/** The block a claim's comment is anchored on, as the server stores it. */
const claimAnchorId = (anchor: VerificationClaim["anchor"]): string =>
  anchor.type === "docx-block"
    ? anchor.blockId
    : readerPdfPageAnchorId(anchor.pageNumber);

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
  const user = useMaybeAuthenticatedUser();
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
  const view = queryView(useQuery({ ...options, enabled: user !== null }));
  useQueryViewError(view, "useClaimComments:query");
  const comments = view.type === "items" ? view.items : [];
  const commentRoutes = () =>
    api.lists({ workspaceId: toSafeId<"workspace">(workspaceId) })[
      "claim-comments"
    ];
  const oneComment = (id: string) =>
    commentRoutes()({ annotationId: toSafeId<"legalReaderAnnotation">(id) });

  const { create, remove, update } = useOptimisticAnnotationMutations({
    handlerId: "claim-comments",
    create: async ({
      body,
      visibility,
    }: {
      body: string;
      visibility: AnnotationVisibility;
    }) =>
      unwrapApiResponse(
        await commentRoutes().post({
          body,
          claimId: toSafeId<"legalListClaim">(claim.id),
          runId: toSafeId<"legalListVerificationRun">(runId),
          visibility,
        }),
      ),
    pendingInput: ({ body, visibility }) => ({
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
    }),
    queryKey,
    remove: async (id: string) =>
      unwrapApiResponse(await oneComment(id).delete()),
    update: async ({ id, ...change }: ClaimCommentChange) =>
      unwrapApiResponse(await oneComment(id).patch(change)),
  });

  return {
    available: user !== null,
    comments: optionalArray(comments).filter(
      (row) => row.kind === "comment" && row.body !== null,
    ),
    create: async (body, visibility) => create({ body, visibility }),
    remove,
    update,
  };
};
