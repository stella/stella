import { create } from "zustand";

import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";

import type { SkillDraft, SkillDraftName } from "./make-skill-review.logic";

/** A drafted skill waiting for its author to approve the names it holds. */
type PendingSkillReview = { draft: SkillDraft; names: SkillDraftName[] };

type MakeSkillReviewStore = {
  pending: PendingSkillReview | null;
  open: (review: PendingSkillReview) => void;
  close: () => void;
};

/**
 * Carries a drafted skill from `/make-skill` in any composer to the one
 * review dialog the signed-in frame mounts.
 */
export const useMakeSkillReviewStore = create<MakeSkillReviewStore>()(
  (set) => ({
    pending: null,
    open: (review) => set({ pending: review }),
    close: () => set({ pending: null }),
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
