import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { CheckIcon, FileTextIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { cn } from "@stll/ui/lib/utils";

import { styleSetsOptions } from "@/features/style-sets/style-set-queries";

export type StyleSelection =
  | { type: "stella" }
  | { type: "custom"; styleSetId: string };

type StyleSetPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string;
  title: string;
  onCreate: (name: string, style: StyleSelection) => Promise<boolean>;
};

const protectedRouteApi = getRouteApi("/_protected");

export const StyleSetPickerDialog = ({
  open,
  onOpenChange,
  initialName,
  title,
  onCreate,
}: StyleSetPickerDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {open ? (
      <StyleSetPickerDialogBody
        initialName={initialName}
        onCreate={onCreate}
        onOpenChange={onOpenChange}
        title={title}
      />
    ) : null}
  </Dialog>
);

const StyleSetPickerDialogBody = ({
  initialName,
  onCreate,
  onOpenChange,
  title,
}: Omit<StyleSetPickerDialogProps, "open">) => {
  const t = useTranslations();
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data, isLoading, isError } = useQuery(
    styleSetsOptions(organizationId),
  );
  const [name, setName] = useState(initialName);
  const [selection, setSelection] = useState<StyleSelection>({
    type: "stella",
  });
  const [creating, setCreating] = useState(false);

  const submit = async () => {
    const normalizedName = name.trim();
    if (normalizedName === "") {
      return;
    }
    setCreating(true);
    const created = await onCreate(normalizedName, selection);
    setCreating(false);
    if (created) {
      onOpenChange(false);
    }
  };

  return (
    <DialogPopup className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {t("styleSets.pickerDescription")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">{t("common.name")}</span>
          <Input
            autoFocus
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("styleSets.title")}</p>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            <StyleChoice
              description={t("styleSets.stellaDescription")}
              name={t("styleSets.stellaStyle")}
              onSelect={() => setSelection({ type: "stella" })}
              selected={selection.type === "stella"}
            />
            {data?.items.map((styleSet) => (
              <StyleChoice
                description={t("styleSets.savedDescription")}
                key={styleSet.id}
                name={styleSet.name}
                onSelect={() =>
                  setSelection({ type: "custom", styleSetId: styleSet.id })
                }
                selected={
                  selection.type === "custom" &&
                  selection.styleSetId === styleSet.id
                }
              />
            ))}
            {isLoading && (
              <p className="text-muted-foreground p-2 text-sm">
                {t("common.loading")}
              </p>
            )}
            {isError && (
              <p className="text-destructive p-2 text-sm">
                {t("styleSets.loadFailed")}
              </p>
            )}
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={creating || isError || name.trim() === ""}
          onClick={submit}
        >
          {creating ? t("common.loading") : t("styleSets.create")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};

type StyleChoiceProps = {
  name: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
};

const StyleChoice = ({
  name,
  description,
  selected,
  onSelect,
}: StyleChoiceProps) => (
  <button
    aria-pressed={selected}
    className={cn(
      "flex w-full items-center gap-3 rounded-lg border p-3 text-start",
      selected && "border-foreground/30 bg-muted",
    )}
    onClick={onSelect}
    type="button"
  >
    <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
      <FileTextIcon className="text-muted-foreground size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{name}</p>
      <p className="text-muted-foreground truncate text-xs">{description}</p>
    </div>
    {selected && <CheckIcon className="size-4 shrink-0" />}
  </button>
);
