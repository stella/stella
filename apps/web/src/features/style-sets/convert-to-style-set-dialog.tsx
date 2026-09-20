import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { Result } from "better-result";
import { CheckIcon, FileTextIcon, PaintbrushIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/dialog";
import { ScrollArea } from "@stll/ui/scroll-area";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { styleSetsOptions } from "@/features/style-sets/style-set-queries";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { ensureRouteQueryData } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys, entityOptions } from "@/lib/workspaces/queries/entities";

type ConvertToStyleSetDialogProps = {
  workspaceId: string;
  viewId: string;
  entityId: string;
  fieldId: string;
};

export const ConvertToStyleSetDialog = (
  props: ConvertToStyleSetDialogProps,
) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button
            aria-label={t("styleSets.convertToHouseStyle")}
            size="icon-xs"
            tooltip={t("styleSets.convertToHouseStyle")}
            variant="ghost"
          >
            <PaintbrushIcon className="size-3.5" />
          </Button>
        }
      />
      {open ? (
        <ConvertToStyleSetDialogBody {...props} onOpenChange={setOpen} />
      ) : null}
    </Dialog>
  );
};

const ConvertToStyleSetDialogBody = ({
  workspaceId,
  viewId,
  entityId,
  fieldId,
  onOpenChange,
}: ConvertToStyleSetDialogProps & {
  onOpenChange: (open: boolean) => void;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const organizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data, isLoading, isError } = useQuery(
    styleSetsOptions(organizationId),
  );
  const [selectedStyleSetId, setSelectedStyleSetId] = useState<string | null>(
    null,
  );
  const [converting, setConverting] = useState(false);

  const runConversion = async (styleSetId: string) => {
    const result = await Result.tryPromise(async () => {
      const converted = unwrapEden(
        await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .entity({ entityId: toSafeId<"entity">(entityId) })
          ["convert-to-style-set"].post({
            fieldId: toSafeId<"field">(fieldId),
            styleSetId: toSafeId<"styleSet">(styleSetId),
          }),
      );
      await queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
      await ensureRouteQueryData(
        queryClient,
        entityOptions(workspaceId, converted.entityId),
      );
      return converted;
    });
    setConverting(false);
    if (Result.isError(result)) {
      analytics.captureError(result.error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        description: userErrorFromThrown(
          result.error,
          t("common.unexpectedError"),
        ),
        type: "error",
      });
      return;
    }
    onOpenChange(false);
    stellaToast.add({
      title: t("styleSets.convertSuccess", { fileName: result.value.fileName }),
      type: "success",
    });
    await navigate({
      to: "/workspaces/$workspaceId/$viewId/document",
      params: { workspaceId, viewId },
      search: { entity: result.value.entityId, field: result.value.fieldId },
    });
    // The restyled copy now fills the main view; its source goes beside it so
    // the two can be read against each other, rather than the copy's metadata.
    await openEntityInInspector(entityId, "", workspaceId);
  };

  const handleConvert = () => {
    if (selectedStyleSetId === null) {
      return;
    }
    setConverting(true);
    detached(
      runConversion(selectedStyleSetId),
      "convert-to-style-set-dialog.convert",
    );
  };

  return (
    <DialogPopup className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t("styleSets.convertTitle")}</DialogTitle>
        <DialogDescription>
          {t("styleSets.convertDescription")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ScrollArea axis="vertical" className="max-h-64">
          <div className="space-y-2">
            {data?.items.map((styleSet) => (
              <StyleSetChoice
                disabled={!styleSet.hasStyleGuide || converting}
                hint={
                  styleSet.hasStyleGuide ? null : t("styleSets.noStyleGuide")
                }
                key={styleSet.id}
                name={styleSet.name}
                onSelect={() => setSelectedStyleSetId(styleSet.id)}
                selected={selectedStyleSetId === styleSet.id}
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
            {!isLoading && !isError && data?.items.length === 0 && (
              <p className="text-muted-foreground p-2 text-sm">
                {t("common.noResults")}
              </p>
            )}
          </div>
        </ScrollArea>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button disabled={converting} variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={selectedStyleSetId === null || converting}
          onClick={handleConvert}
        >
          {converting
            ? t("styleSets.convertPending")
            : t("styleSets.convertConfirm")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};

type StyleSetChoiceProps = {
  name: string;
  disabled: boolean;
  hint: string | null;
  selected: boolean;
  onSelect: () => void;
};

const StyleSetChoice = ({
  name,
  disabled,
  hint,
  selected,
  onSelect,
}: StyleSetChoiceProps) => (
  <button
    aria-pressed={selected}
    className={cn(
      "flex min-h-11 w-full items-center gap-3 rounded-lg border p-3 text-start",
      selected && "border-foreground/30 bg-muted",
      disabled && "cursor-not-allowed opacity-50",
    )}
    disabled={disabled}
    onClick={onSelect}
    type="button"
  >
    <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
      <FileTextIcon className="text-muted-foreground size-4" />
    </div>
    <p className="min-w-0 flex-1 truncate text-sm font-medium">{name}</p>
    {hint === null ? null : (
      <span className="text-muted-foreground shrink-0 text-xs">{hint}</span>
    )}
    {selected && <CheckIcon className="size-4 shrink-0" />}
  </button>
);
