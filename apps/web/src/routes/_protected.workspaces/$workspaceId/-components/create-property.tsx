import { Suspense, useState } from "react";

import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { PropertyContentType } from "@stella/api/types";
import { Button } from "@stella/ui/components/button";
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
} from "@stella/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@stella/ui/components/field";
import { Input } from "@stella/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { Skeleton } from "@stella/ui/components/skeleton";
import { Tabs, TabsList, TabsTab } from "@stella/ui/components/tabs";
import { toastManager } from "@stella/ui/components/toast";

import type { PropertyDependency } from "@/lib/types";
import { PropertyPromptInput } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import type { PropertyPromptFieldHandle } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { usePropertiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import { useCreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";

type CreatePropertyProps = {
  workspaceId: string;
};

type CreationMode = "ai" | "manual";

const CREATION_MODES = [
  "ai",
  "manual",
] as const satisfies readonly CreationMode[];

const PROPERTY_TYPES = [
  "text",
  "single-select",
  "multi-select",
  "date",
  "int",
] as const satisfies readonly PropertyContentType[];

const isCreationMode = (value: unknown): value is CreationMode =>
  typeof value === "string" &&
  (CREATION_MODES as readonly string[]).includes(value);

export const CreateProperty = ({ workspaceId }: CreatePropertyProps) => {
  const t = useTranslations();
  const createProperty = useCreateProperty({ workspaceId });
  const isLimitReached = usePropertiesCountLimit(workspaceId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<CreationMode>("ai");
  const [contentType, setContentType] = useState<PropertyContentType>("text");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  if (isLimitReached) {
    return null;
  }

  const propertyTypeLabels = {
    text: t("workspaces.properties.text"),
    "single-select": t("workspaces.properties.singleSelect"),
    "multi-select": t("workspaces.properties.multiSelect"),
    date: t("workspaces.properties.date"),
    int: t("workspaces.properties.int"),
  } satisfies Record<(typeof PROPERTY_TYPES)[number], string>;

  const modeLabels = {
    ai: t("workspaces.properties.aiExtraction"),
    manual: t("workspaces.properties.manualColumn"),
  } satisfies Record<CreationMode, string>;

  const promptField: PropertyPromptFieldHandle = {
    name: "prompt",
    state: { value: prompt },
    handleChange: setPrompt,
    handleBlur: () => undefined,
  };

  const trimmedName = name.trim();
  const hasMentions = mentions.length > 0;
  const aiReady = prompt.length > 0 && hasMentions;
  const canSubmit = trimmedName.length > 0 && (mode === "manual" || aiReady);
  const showMentionsError = mode === "ai" && submitAttempted && !hasMentions;

  const resetForm = () => {
    setMode("ai");
    setContentType("text");
    setName("");
    setPrompt("");
    setMentions([]);
    setSubmitAttempted(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setDialogOpen(nextOpen);

    if (!nextOpen) {
      resetForm();
    }
  };

  const handleCreate = () => {
    setSubmitAttempted(true);

    if (!canSubmit) {
      return;
    }

    const dependencies: PropertyDependency[] =
      mode === "ai"
        ? mentions.map((id) => ({ dependsOnPropertyId: id, condition: null }))
        : [];

    createProperty.mutate(
      {
        name: trimmedName,
        contentType,
        toolType: mode === "manual" ? "manual-input" : "ai-model",
        ...(mode === "ai" ? { prompt, dependencies } : {}),
      },
      {
        onSuccess: () => {
          setDialogOpen(false);
          resetForm();
        },
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={dialogOpen}>
      <DialogTrigger
        render={
          <Button
            className="hover:bg-accent h-full! min-w-10 rounded-none"
            disabled={createProperty.isPending}
            size="icon"
            type="button"
            variant="ghost"
          />
        }
      >
        <PlusIcon />
      </DialogTrigger>

      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workspaces.properties.newColumn")}</DialogTitle>
          <DialogDescription>
            {t("workspaces.properties.newColumnDescription")}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <Tabs
            onValueChange={(value) => {
              if (isCreationMode(value)) {
                setMode(value);
                setSubmitAttempted(false);
              }
            }}
            value={mode}
          >
            <TabsList className="w-full">
              {CREATION_MODES.map((value) => (
                <TabsTab key={value} value={value}>
                  {modeLabels[value]}
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>

          <Field>
            <FieldLabel>{t("common.name")}</FieldLabel>
            <Input
              autoComplete="off"
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) {
                  handleCreate();
                }
              }}
              placeholder={t("workspaces.properties.newColumnName")}
              value={name}
            />
          </Field>

          <Field>
            <FieldLabel>{t("workspaces.properties.resultType")}</FieldLabel>
            <Select
              onValueChange={(value) => {
                if (value) {
                  setContentType(value);
                }
              }}
              value={contentType}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {PROPERTY_TYPES.map((type) => (
                  <SelectItem
                    key={type}
                    label={propertyTypeLabels[type]}
                    value={type}
                  >
                    <PropertyIcon
                      className="text-muted-foreground"
                      type={type}
                    />
                    <span>{propertyTypeLabels[type]}</span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          {mode === "ai" && (
            <Field {...(showMentionsError ? { "data-invalid": true } : {})}>
              <FieldLabel>
                {t("workspaces.properties.extractionInstruction")}
              </FieldLabel>
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <PropertyPromptInput
                  field={promptField}
                  onMentionsChange={setMentions}
                  propertyId=""
                  propertyName={trimmedName}
                  workspaceId={workspaceId}
                />
              </Suspense>
              {showMentionsError ? (
                <p className="text-destructive-foreground text-xs">
                  {t("workspaces.properties.addInputProperty")}
                </p>
              ) : (
                <FieldDescription>
                  {t("workspaces.properties.extractionInstructionHelp")}
                </FieldDescription>
              )}
            </Field>
          )}
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={createProperty.isPending || trimmedName.length === 0}
            loading={createProperty.isPending}
            onClick={handleCreate}
          >
            {t("workspaces.properties.createColumn")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
