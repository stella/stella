import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogFormState,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import {
  ClipboardCheckIcon,
  LibraryIcon,
  type LucideIcon,
  PencilLineIcon,
} from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import type { MatterOption } from "@/components/workspaces/matter-combobox";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import type { MatterDraftClient } from "@/lib/workspaces/create-matter-store";

import { SkillAvailabilityField } from "./skill-availability-field";
import {
  coerceSkillAvailability,
  skillBindingBody,
} from "./skill-availability.logic";
import type {
  SkillAvailability,
  SkillBindingBody,
  SkillScope,
} from "./skill-availability.logic";

type BlueprintId =
  "check-against-rules" | "intake-to-draft" | "answer-from-sources" | "blank";
type BlueprintCardId = Exclude<BlueprintId, "blank">;

export type BlueprintCreatedSkill = {
  id: string;
};

type CardText = { title: string; blurb: string; inside: string };

// Order here is the gallery's display order.
const CARDS = [
  { id: "check-against-rules", Icon: ClipboardCheckIcon },
  { id: "intake-to-draft", Icon: PencilLineIcon },
  { id: "answer-from-sources", Icon: LibraryIcon },
] as const satisfies readonly {
  id: BlueprintCardId;
  Icon: LucideIcon;
}[];

type BlueprintGallerySheetProps = {
  canManageTeam: boolean;
  onCreated: (skill: BlueprintCreatedSkill) => void;
  onOpenChange: (open: boolean) => void;
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
}: BlueprintGallerySheetProps) => {
  const t = useTranslations();
  const tGallery = useTranslations("knowledge.skills.blueprintGallery");
  const [scope, setScope] = useState<SkillScope>("private");
  const [availability, setAvailability] =
    useState<SkillAvailability>("everywhere");
  const [matter, setMatter] = useState<MatterOption | null>(null);
  const [client, setClient] = useState<MatterDraftClient | null>(null);
  // `null` while the chosen matter or client is still missing.
  const binding = skillBindingBody({
    availability,
    clientId: client?.id ?? null,
    matterId: matter?.id ?? null,
  });
  const changeScope = (next: SkillScope) => {
    setScope(next);
    setAvailability(
      coerceSkillAvailability({ availability, canManageTeam, scope: next }),
    );
  };
  const resetForm = () => {
    setScope("private");
    setAvailability("everywhere");
    setMatter(null);
    setClient(null);
  };

  // Literal keys per card so a stale/missing key fails typecheck without
  // widening to the full TranslationKey union (which would force a values arg).
  const cardText = (id: BlueprintCardId): CardText => {
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

  const submitIntent = useIdempotentSubmit();
  const create = useMutation({
    mutationFn: async ({
      bindingFields,
      id,
    }: {
      bindingFields: SkillBindingBody;
      id: BlueprintId;
    }) => {
      const response = await submitIntent.run({
        operation: "skills.from-blueprint",
        body: { scope, blueprintId: id, ...bindingFields },
        send: (body, request) =>
          api.skills["from-blueprint"].post(body, request),
      });
      return { id: unwrapApiResponse(response).id };
    },
    onSuccess: ({ id }) => {
      onCreated({ id });
      onOpenChange(false);
    },
    onError: (error) => {
      notifyUserError(error, t("common.unexpectedError"), {
        description: userErrorFromThrown(error, t("common.unexpectedError")),
      });
    },
  });

  const pendingId = create.isPending ? create.variables.id : undefined;
  const createFrom = (id: BlueprintId) => {
    if (binding !== null) {
      create.mutate({ bindingFields: binding, id });
    }
  };
  const cannotCreate = create.isPending || binding === null;

  return (
    <DialogPopup className="sm:max-w-2xl">
      <DialogFormState
        dirty={scope !== "private" || availability !== "everywhere"}
        onDiscard={resetForm}
      />
      <DialogHeader>
        <DialogTitle>{tGallery("title")}</DialogTitle>
        <p className="text-muted-foreground text-sm">{tGallery("subtitle")}</p>
      </DialogHeader>

      <DialogPanel className="flex flex-col gap-3">
        {/* Members may share with the team too, bound to one matter. */}
        <div className="flex flex-col gap-2">
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
                  changeScope(value);
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
          <SkillAvailabilityField
            availability={availability}
            canManageTeam={canManageTeam}
            client={client}
            matter={matter}
            onAvailabilityChange={setAvailability}
            onClientChange={setClient}
            onMatterChange={setMatter}
            scope={scope}
          />
        </div>

        {CARDS.map((card) => {
          const text = cardText(card.id);
          return (
            <button
              className="border-border hover:border-foreground/30 hover:bg-muted/40 flex items-start gap-3 rounded-lg border p-4 text-start disabled:opacity-60"
              disabled={cannotCreate}
              key={card.id}
              onClick={() => createFrom(card.id)}
              type="button"
            >
              <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                {pendingId === card.id ? (
                  <Loader
                    className="size-4"
                    label={t("common.loading")}
                    size="sm"
                  />
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

        {/* The blank scaffold is a blueprint too — no form, the user lands
            straight in the editor and fills the skill in there. */}
        <button
          className="text-muted-foreground hover:text-foreground flex items-center rounded-md border border-dashed px-4 py-3 text-start text-sm disabled:opacity-60"
          disabled={cannotCreate}
          onClick={() => createFrom("blank")}
          type="button"
        >
          {pendingId === "blank" && (
            <Loader
              className="me-2 size-4 shrink-0"
              label={t("common.loading")}
              size="sm"
            />
          )}
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
