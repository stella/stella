import { useState } from "react";
import type { SubmitEvent } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { StyleSetEditorControls } from "@/features/style-sets/style-set-editor-controls";
import type {
  StyleSetEditorSettings,
  StyleSetEditorTarget,
} from "@/features/style-sets/style-set-editor-types";
import { StyleSetPreview } from "@/features/style-sets/style-set-preview";
import {
  styleSetEditorOptions,
  styleSetsKeys,
  stellaStyleEditorOptions,
} from "@/features/style-sets/style-set-queries";
import { api } from "@/lib/api";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";

const protectedRouteApi = getRouteApi("/_protected");

type StyleSetEditorDialogProps = {
  target: StyleSetEditorTarget;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
};

export const StyleSetEditorDialog = ({
  target,
  onOpenChange,
  onSaved,
}: StyleSetEditorDialogProps) => {
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogPopup
        className="h-[calc(100dvh-2rem)] max-w-6xl"
        bottomStickOnMobile={false}
      >
        {target.type === "stella" ? (
          <StellaStyleEditorLoader
            onOpenChange={onOpenChange}
            onSaved={onSaved}
            organizationId={organizationId}
          />
        ) : (
          <SavedStyleEditorLoader
            onOpenChange={onOpenChange}
            onSaved={onSaved}
            organizationId={organizationId}
            styleSetId={target.styleSetId}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
};

const StellaStyleEditorLoader = ({
  organizationId,
  onOpenChange,
  onSaved,
}: Omit<StyleSetEditorDialogProps, "target"> & {
  organizationId: string;
}) => {
  const query = useQuery(stellaStyleEditorOptions(organizationId));
  if (query.isLoading) {
    return <StyleSetEditorSkeleton />;
  }
  if (query.isError || !query.data) {
    return <StyleSetEditorError />;
  }
  return (
    <LoadedStyleSetEditor
      initialName=""
      initialSettings={query.data.settings}
      onOpenChange={onOpenChange}
      onSaved={onSaved}
      organizationId={organizationId}
      saveTarget={{ type: "stella" }}
    />
  );
};

const SavedStyleEditorLoader = ({
  organizationId,
  styleSetId,
  onOpenChange,
  onSaved,
}: Omit<StyleSetEditorDialogProps, "target"> & {
  organizationId: string;
  styleSetId: string;
}) => {
  const query = useQuery(styleSetEditorOptions({ organizationId, styleSetId }));
  if (query.isLoading) {
    return <StyleSetEditorSkeleton />;
  }
  if (query.isError || !query.data) {
    return <StyleSetEditorError />;
  }
  const expectedUpdatedAt = new Date(query.data.updatedAt).toISOString();
  return (
    <LoadedStyleSetEditor
      initialName={query.data.name}
      initialSettings={query.data.settings}
      key={expectedUpdatedAt}
      onOpenChange={onOpenChange}
      onSaved={onSaved}
      organizationId={organizationId}
      saveTarget={{
        type: "saved",
        styleSetId,
        expectedUpdatedAt,
      }}
    />
  );
};

type EditorSaveTarget =
  | { type: "stella" }
  | {
      type: "saved";
      styleSetId: string;
      expectedUpdatedAt: string;
    };

type LoadedStyleSetEditorProps = {
  initialName: string;
  initialSettings: StyleSetEditorSettings;
  organizationId: string;
  saveTarget: EditorSaveTarget;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
};

const LoadedStyleSetEditor = ({
  initialName,
  initialSettings,
  organizationId,
  saveTarget,
  onOpenChange,
  onSaved,
}: LoadedStyleSetEditorProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);

  const finishSave = async (
    error: Parameters<typeof userErrorMessage>[0] | null,
  ) => {
    if (error) {
      setSaving(false);
      stellaToast.add({
        type: "error",
        title: t("styleSets.editor.saveFailed"),
        description: userErrorMessage(error, t("common.unexpectedError")),
      });
      return;
    }

    await queryClient.invalidateQueries({
      queryKey: styleSetsKeys.all(organizationId),
    });
    await onSaved();
    stellaToast.add({
      type: "success",
      title: t("styleSets.editor.saved"),
    });
    onOpenChange(false);
  };

  const save = async () => {
    const normalizedName = name.trim();
    if (normalizedName === "") {
      return;
    }
    setSaving(true);
    if (saveTarget.type === "stella") {
      const response = await api["style-sets"].editor.put({
        name: normalizedName,
        settings,
      });
      await finishSave(response.error);
      return;
    }

    const response = await api["style-sets"]({
      styleSetId: toSafeId<"styleSet">(saveTarget.styleSetId),
    }).editor.post({
      name: normalizedName,
      expectedUpdatedAt: saveTarget.expectedUpdatedAt,
      settings,
    });
    await finishSave(response.error);
  };

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save().catch((error: unknown) => {
      setSaving(false);
      stellaToast.add({
        type: "error",
        title: t("styleSets.editor.saveFailed"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
      });
    });
  };

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
      <DialogHeader className="border-b pe-14">
        <DialogTitle>
          {saveTarget.type === "stella"
            ? t("styleSets.editor.createTitle")
            : t("styleSets.editor.editTitle")}
        </DialogTitle>
        <DialogDescription>
          {t("styleSets.editor.description")}
        </DialogDescription>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[24rem_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col border-b lg:border-e lg:border-b-0">
          <div className="border-b px-5 py-4">
            <Field>
              <FieldLabel htmlFor="style-set-editor-name">
                {t("common.name")}
              </FieldLabel>
              <Input
                autoFocus
                id="style-set-editor-name"
                maxLength={256}
                onChange={(event) => setName(event.currentTarget.value)}
                required
                value={name}
              />
            </Field>
          </div>
          <StyleSetEditorControls onChange={setSettings} settings={settings} />
        </div>
        <StyleSetPreview settings={settings} />
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button disabled={saving || name.trim() === ""} type="submit">
          {saving ? t("common.loading") : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
};

const StyleSetEditorSkeleton = () => (
  <div className="flex min-h-0 flex-1 flex-col">
    <DialogHeader className="border-b pe-14">
      <Skeleton className="h-6 w-52" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </DialogHeader>
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <div className="space-y-4 border-b p-5 lg:border-e lg:border-b-0">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
      <div className="bg-muted/48 flex justify-center p-10">
        <Skeleton className="h-full max-h-[42rem] w-full max-w-[32rem]" />
      </div>
    </div>
    <DialogFooter>
      <Skeleton className="h-8 w-20" />
      <Skeleton className="h-8 w-20" />
    </DialogFooter>
  </div>
);

const StyleSetEditorError = () => {
  const t = useTranslations();
  return (
    <div className="flex min-h-72 flex-1 items-center justify-center p-8">
      <p className="text-muted-foreground text-sm">
        {t("styleSets.editor.loadFailed")}
      </p>
    </div>
  );
};
