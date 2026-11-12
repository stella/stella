import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";

import { saveSkillDraft, useMakeSkillReviewStore } from "./make-skill-review";

type MakeSkillTarget = {
  threadRef: ChatThreadRef;
  /** What the lawyer typed after `/make-skill`; "" lets the server decide. */
  intent: string;
};

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
 * `/make-skill`: draft a skill from the current chat. A draft without names
 * of people or organizations is stored at once as a private, disabled skill;
 * one with names goes to the review dialog first, since a stored skill
 * reaches everyone it is later shared with.
 */
export const useMakeSkillFromChat = () => {
  const t = useTranslations();
  const openSaved = useOpenSavedSkill();
  const openReview = useMakeSkillReviewStore((store) => store.open);
  const make = useMutation({
    mutationFn: async ({ threadRef, intent }: MakeSkillTarget) => {
      const drafted = await invokeAppOnlyWrite(
        "skills.from-chat.create",
        async () =>
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
      if (drafted.names.length > 0) {
        return { type: "review" as const, ...drafted };
      }
      const saved = await saveSkillDraft(drafted.draft, []);
      return saved.type === "saved"
        ? saved
        : { type: "review" as const, draft: drafted.draft, names: saved.names };
    },
  });

  return (target: MakeSkillTarget) => {
    if (make.isPending) {
      return;
    }
    const toastId = stellaToast.loading(t("chat.makeSkill.drafting"));
    make.mutate(target, {
      onSuccess: (outcome) => {
        stellaToast.close(toastId);
        if (outcome.type === "saved") {
          openSaved(outcome.skill.id);
          return;
        }
        openReview({
          draft: outcome.draft,
          names: outcome.names,
          approved: [],
        });
      },
      onError: (error) => {
        stellaToast.close(toastId);
        notifyUserError(error, t("chat.makeSkill.failed"), {
          description: userErrorFromThrown(error, t("chat.makeSkill.failed")),
        });
      },
    });
  };
};
