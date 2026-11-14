import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { useSingleFlight } from "@/hooks/use-single-flight";
import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { resourceMutation } from "@/lib/workspace-realtime";

import {
  saveSkillDraft,
  type SkillDraftSaveOutcome,
  useMakeSkillReviewStore,
} from "./make-skill-review";
import type { SkillDraft } from "./make-skill-review.logic";

type MakeSkillTarget = {
  threadRef: ChatThreadRef;
  /** What the lawyer typed after `/make-skill`; "" lets the server decide. */
  intent: string;
};

/**
 * Draft a skill from a chat. A read: the draft comes back with the names it
 * holds and nothing is stored, like a proposed answer edit.
 */
const draftSkillFromChat = async ({ threadRef, intent }: MakeSkillTarget) =>
  await invokeAppOnlyWrite("skills.from-chat.read", async () =>
    unwrapApiResponse(
      await api.skills["from-chat"].post({
        threadId: threadRef.threadId,
        ...(threadRef.scope === "workspace"
          ? { workspaceId: threadRef.workspaceId }
          : {}),
        ...(intent.length > 0 ? { intent } : {}),
      }),
    ),
  );

/** Announce a stored draft and open it for review. */
export const useOpenSavedSkill = () => {
  const t = useTranslations();
  const navigate = useNavigate();
  return (skillId: string) => {
    stellaToast.add({ title: t("chat.makeSkill.drafted"), type: "success" });
    detached(
      navigate({ to: "/knowledge/tools/$entry", params: { entry: skillId } }),
      "make-skill.open-saved",
    );
  };
};

/**
 * Store a drafted skill that holds no names to review. The server checks it
 * again; names it finds go to the review dialog instead. The outcome is
 * handled on the mutation, not on `mutate`, so it still lands when the
 * composer that asked has unmounted.
 */
export const useSaveDraftedSkill = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const openSaved = useOpenSavedSkill();
  const openReview = useMakeSkillReviewStore((store) => store.open);
  return useMutation({
    mutationFn: resourceMutation({
      mutation: "saveSkillDraft",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (draft: SkillDraft) => await saveSkillDraft(draft, []),
    }),
    onSuccess: (outcome: SkillDraftSaveOutcome, draft: SkillDraft) => {
      if (outcome.type === "saved") {
        openSaved(outcome.skill.id);
        return;
      }
      openReview({ draft, names: outcome.names, approved: [] });
    },
    onError: (error) => {
      notifyUserError(error, t("chat.makeSkill.failed"), {
        description: userErrorFromThrown(error, t("chat.makeSkill.failed")),
      });
    },
  });
};

/**
 * `/make-skill`: draft a skill from the current chat. A draft without names
 * of people or organizations is stored at once, through `saveDraft`, as a
 * private, disabled skill; one with names goes to the review dialog first,
 * since a stored skill reaches everyone it is later shared with.
 */
export const useMakeSkillFromChat = (
  saveDraft: ReturnType<typeof useSaveDraftedSkill>,
) => {
  const t = useTranslations();
  const openReview = useMakeSkillReviewStore((store) => store.open);
  const flight = useSingleFlight();

  const make = async (target: MakeSkillTarget) => {
    const toastId = stellaToast.loading(t("chat.makeSkill.drafting"));
    const drafted = await Result.tryPromise({
      try: async () => await draftSkillFromChat(target),
      catch: (cause: unknown): unknown => cause,
    });
    stellaToast.close(toastId);
    if (Result.isError(drafted)) {
      notifyUserError(drafted.error, t("chat.makeSkill.failed"), {
        description: userErrorFromThrown(
          drafted.error,
          t("chat.makeSkill.failed"),
        ),
      });
      return;
    }
    const { draft, names } = drafted.value;
    if (names.length > 0) {
      openReview({ draft, names, approved: [] });
      return;
    }
    saveDraft.mutate(draft);
  };

  return (target: MakeSkillTarget) => {
    if (saveDraft.isPending) {
      return;
    }
    detached(
      flight.run(async () => await make(target)),
      "make-skill.draft",
    );
  };
};
