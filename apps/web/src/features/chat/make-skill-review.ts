import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";

import { api } from "@/lib/api";
import { sessionOptions } from "@/lib/auth-queries";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";

import type { SkillDraft, SkillDraftName } from "./make-skill-review.logic";

/** The account and organization a draft was made in. */
export type SkillDraftOwner = { userId: string; organizationId: string };

/** The account and organization the session has now, if it has both. */
export const currentDraftOwner = (
  queryClient: QueryClient,
): SkillDraftOwner | null => {
  const current = queryClient.getQueryData(sessionOptions.queryKey);
  const organizationId = current?.session.activeOrganizationId;
  return current && organizationId
    ? { userId: current.user.id, organizationId }
    : null;
};

/**
 * Whether the session is still the one `owner` drafted in. A draft or a
 * save that finishes after a switch of account or organization belongs to
 * the one it started in: it is neither saved into nor shown in the new one.
 */
export const isCurrentDraftOwner = (
  queryClient: QueryClient,
  owner: SkillDraftOwner,
) => {
  const current = currentDraftOwner(queryClient);
  return (
    current !== null &&
    current.userId === owner.userId &&
    current.organizationId === owner.organizationId
  );
};

/**
 * A drafted skill waiting for its author to approve the names it holds:
 * `names` to decide now, `approved` the names kept in earlier rounds.
 */
type SkillReview = {
  draft: SkillDraft;
  names: SkillDraftName[];
  approved: string[];
  owner: SkillDraftOwner;
};

/** A review as the dialog shows it; `id` is new for every round. */
export type PendingSkillReview = SkillReview & { id: number };

type MakeSkillReviewStore = {
  /** The review the dialog shows first, then the ones waiting behind it. */
  queue: PendingSkillReview[];
  nextId: number;
  /** Queue a new draft's review behind any already open. */
  open: (review: SkillReview) => void;
  /** Ask again, in place of review `id`, about the names the server found. */
  reopen: (id: number, review: SkillReview) => void;
  /** Review `id` is settled: saved or dismissed. */
  close: (id: number) => void;
  /** Drop every review, as when the signed-in frame goes. */
  clear: () => void;
};

/**
 * Carries drafted skills from `/make-skill` in any composer to the one
 * review dialog the signed-in frame mounts. A draft that finishes while
 * another is in review waits its turn instead of replacing it.
 */
export const useMakeSkillReviewStore = create<MakeSkillReviewStore>()(
  (set) => ({
    queue: [],
    nextId: 1,
    open: (review) =>
      set((state) => ({
        queue: [...state.queue, { ...review, id: state.nextId }],
        nextId: state.nextId + 1,
      })),
    reopen: (id, review) =>
      set((state) => ({
        queue: state.queue.map((pending) =>
          pending.id === id ? { ...review, id: state.nextId } : pending,
        ),
        nextId: state.nextId + 1,
      })),
    close: (id) =>
      set((state) => ({
        queue: state.queue.filter((pending) => pending.id !== id),
      })),
    clear: () => set({ queue: [] }),
  }),
);

/**
 * Store a reviewed draft. The server checks it for names again and answers
 * `review` with any its author has not approved, `saved` with the skill.
 */
export const saveSkillDraft = async (
  draft: SkillDraft,
  approvedNames: readonly string[],
) =>
  await invokeAppOnlyWrite("skills.save-draft.create", async () =>
    unwrapApiResponse(
      await api.skills["save-draft"].post({
        markdown: draft.markdown,
        resources: draft.resources,
        approvedNames: [...approvedNames],
      }),
    ),
  );

/** What storing a draft answers: the saved skill, or names still to review. */
export type SkillDraftSaveOutcome = Awaited<ReturnType<typeof saveSkillDraft>>;
