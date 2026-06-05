import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import {
  BookOpenIcon,
  ClipboardCheckIcon,
  LoaderIcon,
  PencilLineIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toAPIError, userErrorFromThrown } from "@/lib/errors";

type SkillScope = "team" | "private";
type BlueprintId =
  | "check-against-rules"
  | "intake-to-draft"
  | "answer-from-sources";

export type BlueprintCreatedSkill = {
  id: string;
  name: string;
  scope: SkillScope;
};

type CardText = { title: string; blurb: string; inside: string };

// Order here is the gallery's display order.
const CARDS = [
  { id: "check-against-rules", Icon: ClipboardCheckIcon },
  { id: "intake-to-draft", Icon: PencilLineIcon },
  { id: "answer-from-sources", Icon: BookOpenIcon },
] as const satisfies readonly { id: BlueprintId; Icon: typeof BookOpenIcon }[];

type BlueprintGallerySheetProps = {
  canManageTeam: boolean;
  onCreated: (skill: BlueprintCreatedSkill) => void;
  onOpenChange: (open: boolean) => void;
  onStartBlank: () => void;
  open: boolean;
};

export const BlueprintGallerySheet = (props: BlueprintGallerySheetProps) => (
  <Dialog onOpenChange={props.onOpenChange} open={props.open}>
    {props.open ? <BlueprintGallerySheetBody {...props} /> : null}
  </Dialog>
);

const BlueprintGallerySheetBody = ({
  canManageTeam,
  onCreated,
  onOpenChange,
  onStartBlank,
}: BlueprintGallerySheetProps) => {
  const t = useTranslations();
  const tGallery = useTranslations("knowledge.skills.blueprintGallery");
  const [scope, setScope] = useState<SkillScope>("private");

  // Literal keys per card so a stale/missing key fails typecheck without
  // widening to the full TranslationKey union (which would force a values arg).
  const cardText = (id: BlueprintId): CardText => {
    if (id === "check-against-rules") {
      return {
        title: t(
          "knowledge.skills.blueprintGallery.cards.checkAgainstRules.title",
        ),
        blurb: t(
          "knowledge.skills.blueprintGallery.cards.checkAgainstRules.blurb",
        ),
        inside: t(
          "knowledge.skills.blueprintGallery.cards.checkAgainstRules.inside",
        ),
      };
    }
    if (id === "intake-to-draft") {
      return {
        title: t("knowledge.skills.blueprintGallery.cards.intakeToDraft.title"),
        blurb: t("knowledge.skills.blueprintGallery.cards.intakeToDraft.blurb"),
        inside: t(
          "knowledge.skills.blueprintGallery.cards.intakeToDraft.inside",
        ),
      };
    }
    return {
      title: t(
        "knowledge.skills.blueprintGallery.cards.answerFromSources.title",
      ),
      blurb: t(
        "knowledge.skills.blueprintGallery.cards.answerFromSources.blurb",
      ),
      inside: t(
        "knowledge.skills.blueprintGallery.cards.answerFromSources.inside",
      ),
    };
  };

  const create = useMutation({
    mutationFn: async (id: BlueprintId) => {
      const response = await api.skills["from-blueprint"].post({
        scope,
        blueprintId: id,
        queryKey: ["skills"],
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return { id: response.data.id, name: cardText(id).title };
    },
    onSuccess: ({ id, name }) => {
      onCreated({ id, name, scope });
      onOpenChange(false);
    },
    onError: (error) => {
      stellaToast.add({
        title: tGallery("createError"),
        description: userErrorFromThrown(error, tGallery("createError")),
        type: "error",
      });
    },
  });

  const pendingId = create.isPending ? create.variables : undefined;

  return (
    <DialogPopup className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{tGallery("title")}</DialogTitle>
        <p className="text-muted-foreground text-sm">{tGallery("subtitle")}</p>
      </DialogHeader>

      <DialogPanel className="flex flex-col gap-3">
        {canManageTeam && (
          <div className="flex items-center justify-end gap-2">
            <label
              className="text-muted-foreground text-xs"
              htmlFor="blueprint-scope"
            >
              {t("knowledge.skills.form.scope")}
            </label>
            <Select
              onValueChange={(value) => {
                if (value === "team" || value === "private") {
                  setScope(value);
                }
              }}
              value={scope}
            >
              <SelectTrigger className="w-44" id="blueprint-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="private">
                  {t("knowledge.skills.form.scopePrivate")}
                </SelectItem>
                <SelectItem value="team">
                  {t("knowledge.skills.form.scopeTeam")}
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>
        )}

        {CARDS.map((card) => {
          const text = cardText(card.id);
          return (
            <button
              className="border-border hover:border-foreground/30 hover:bg-muted/40 flex items-start gap-3 rounded-lg border p-4 text-start transition-colors disabled:opacity-60"
              disabled={create.isPending}
              key={card.id}
              onClick={() => create.mutate(card.id)}
              type="button"
            >
              <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                {pendingId === card.id ? (
                  <LoaderIcon className="size-4 animate-spin" />
                ) : (
                  <card.Icon className="size-4" />
                )}
              </span>
              <span className="flex flex-col gap-1">
                <span className="text-foreground text-sm font-medium">
                  {text.title}
                </span>
                <span className="text-muted-foreground text-sm">
                  {text.blurb}
                </span>
                <span className="text-muted-foreground mt-1 text-xs">
                  {tGallery("insideLabel")}: {text.inside}
                </span>
              </span>
            </button>
          );
        })}

        <button
          className="text-muted-foreground hover:text-foreground rounded-md border border-dashed px-4 py-3 text-start text-sm transition-colors disabled:opacity-60"
          disabled={create.isPending}
          onClick={() => {
            onOpenChange(false);
            onStartBlank();
          }}
          type="button"
        >
          <span className="text-foreground font-medium">
            {tGallery("startBlank")}
          </span>
          <span className="ms-2">{tGallery("startBlankHint")}</span>
        </button>
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
      </DialogFooter>
    </DialogPopup>
  );
};
