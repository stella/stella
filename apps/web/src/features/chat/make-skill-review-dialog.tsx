import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogFormState,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Label } from "@stll/ui/label";

import { useMountEffect } from "@/hooks/use-effect";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { resourceMutation } from "@/lib/workspace-realtime";

import {
  isCurrentDraftOwner,
  type PendingSkillReview,
  saveSkillDraft,
  type SkillDraftSaveOutcome,
  useMakeSkillReviewStore,
} from "./make-skill-review";
import {
  mergeApprovedNames,
  replaceDraftNames,
  type SkillDraft,
} from "./make-skill-review.logic";
import { useOpenSavedSkill } from "./use-make-skill-from-chat";

/**
 * Asks the author of a drafted skill whether the names it holds may be
 * stored. Every name starts kept, so approving all is one click; an unticked
 * name is replaced by its role before the draft is saved.
 */
export const MakeSkillReviewDialog = () => {
  const pending = useMakeSkillReviewStore((store) => store.queue.at(0));
  const close = useMakeSkillReviewStore((store) => store.close);
  // The signed-in frame unmounts on any change of user or organization; the
  // drafts waiting for review leave with it, so the next member never sees
  // their names.
  useMountEffect(() => () => {
    useMakeSkillReviewStore.getState().clear();
  });
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && pending !== undefined) {
          close(pending.id);
        }
      }}
      open={pending !== undefined}
    >
      {pending === undefined ? null : (
        <MakeSkillReviewBody
          // A new review (another draft, or names the server found again)
          // starts from its own list, every name kept.
          key={pending.id}
          review={pending}
        />
      )}
    </Dialog>
  );
};

/** A reviewed draft as it was saved, with the names approved so far. */
type ReviewedSave = {
  approvedNow: string[];
  reviewed: SkillDraft;
  outcome: SkillDraftSaveOutcome;
};

const MakeSkillReviewBody = ({
  review: { id: reviewId, approved, draft, names, owner },
}: {
  review: PendingSkillReview;
}) => {
  const t = useTranslations();
  const tReview = useTranslations("chat.makeSkill.review");
  const queryClient = useQueryClient();
  const reopenReview = useMakeSkillReviewStore((store) => store.reopen);
  const closeReview = useMakeSkillReviewStore((store) => store.close);
  const openSaved = useOpenSavedSkill();
  const [kept, setKept] = useState<ReadonlySet<string>>(
    () => new Set(names.map(({ value }) => value)),
  );
  const save = useMutation({
    mutationFn: resourceMutation({
      mutation: "saveSkillDraft",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async () => {
        const replaced = names.filter(({ value }) => !kept.has(value));
        const reviewed = replaceDraftNames(draft, replaced, (kind) =>
          // The brackets mark a role in skill text, so they are not
          // translated.
          kind === "person"
            ? `<${tReview("role.person")}>`
            : `<${tReview("role.organization")}>`,
        );
        // Names kept in an earlier round stay approved: the server checks
        // the whole draft again on every save.
        const approvedNow = mergeApprovedNames(approved, kept);
        return {
          approvedNow,
          reviewed,
          outcome: await saveSkillDraft(reviewed, approvedNow),
        };
      },
    }),
    onSuccess: ({ approvedNow, reviewed, outcome }: ReviewedSave) => {
      // A save that answers after a switch of account or organization is
      // not shown in the one switched to.
      if (!isCurrentDraftOwner(queryClient, owner)) {
        return;
      }
      if (outcome.type === "saved") {
        closeReview(reviewId);
        openSaved(outcome.skill.id);
        return;
      }
      reopenReview(reviewId, {
        approved: approvedNow,
        draft: reviewed,
        names: outcome.names,
        owner,
      });
    },
    onError: (error) => {
      notifyUserError(error, t("chat.makeSkill.failed"), {
        description: userErrorFromThrown(error, t("chat.makeSkill.failed")),
      });
    },
  });

  const toggle = (value: string, keep: boolean) => {
    setKept((current) => {
      const next = new Set(current);
      if (keep) {
        next.add(value);
      } else {
        next.delete(value);
      }
      return next;
    });
  };

  return (
    <DialogPopup className="sm:max-w-lg">
      <DialogFormState
        dirty={kept.size !== names.length}
        onDiscard={() => setKept(new Set(names.map(({ value }) => value)))}
      />
      <DialogHeader>
        <DialogTitle>{tReview("title")}</DialogTitle>
        <DialogDescription>{tReview("description")}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ul className="flex flex-col gap-2">
          {names.map(({ kind, value }, index) => {
            const id = `make-skill-name-${index}`;
            return (
              <li className="flex items-center gap-2" key={value}>
                <Checkbox
                  checked={kept.has(value)}
                  id={id}
                  onCheckedChange={(checked) => toggle(value, checked)}
                />
                <Label htmlFor={id}>
                  <span>{value}</span>
                  <span className="text-muted-foreground ms-2 text-xs">
                    {kind === "person"
                      ? t("common.anonymizationLabels.person")
                      : t("common.anonymizationLabels.organization")}
                  </span>
                </Label>
              </li>
            );
          })}
        </ul>
        <p className="text-muted-foreground mt-3 text-sm">
          {tReview("replaceHint")}
        </p>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          loading={save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {kept.size === names.length
            ? tReview("saveAll")
            : tReview("saveReplacing")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};
