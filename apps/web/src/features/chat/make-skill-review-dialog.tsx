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
  saveSkillDraft,
  type SkillDraftSaveOutcome,
  useMakeSkillReviewStore,
} from "./make-skill-review";
import {
  mergeApprovedNames,
  replaceDraftNames,
  type SkillDraft,
  type SkillDraftName,
} from "./make-skill-review.logic";
import { useOpenSavedSkill } from "./use-make-skill-from-chat";

/**
 * Asks the author of a drafted skill whether the names it holds may be
 * stored. Every name starts kept, so approving all is one click; an unticked
 * name is replaced by its role before the draft is saved.
 */
export const MakeSkillReviewDialog = () => {
  const pending = useMakeSkillReviewStore((store) => store.pending);
  const close = useMakeSkillReviewStore((store) => store.close);
  // The signed-in frame unmounts on any change of user; a draft waiting for
  // review leaves with it, so the next member never sees its names.
  useMountEffect(() => () => {
    useMakeSkillReviewStore.getState().close();
  });
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open={pending !== null}
    >
      {pending === null ? null : (
        <MakeSkillReviewBody
          // A new review (another draft, or names the server found again)
          // starts from its own list, every name kept.
          key={pending.names.map(({ value }) => value).join("\u0000")}
          approved={pending.approved}
          draft={pending.draft}
          names={pending.names}
          onDone={close}
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
  approved,
  draft,
  names,
  onDone,
}: {
  approved: string[];
  draft: SkillDraft;
  names: SkillDraftName[];
  onDone: () => void;
}) => {
  const t = useTranslations();
  const tReview = useTranslations("chat.makeSkill.review");
  const queryClient = useQueryClient();
  const openReview = useMakeSkillReviewStore((store) => store.open);
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
      if (outcome.type === "saved") {
        onDone();
        openSaved(outcome.skill.id);
        return;
      }
      openReview({
        approved: approvedNow,
        draft: reviewed,
        names: outcome.names,
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
