import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { ORGANIZATION_SLUG_RULES } from "@stll/auth-model";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Field, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Input } from "@stll/ui/input";

import { api } from "@/lib/api";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";

type OrganizationSlugCardProps = {
  slug: string;
  canChange: boolean;
  onSuccess: () => Promise<void>;
};

const SLUG_CONFLICT_CODE = "organization_slug_conflict";

export const OrganizationSlugCard = ({
  slug,
  canChange,
  onSuccess,
}: OrganizationSlugCardProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(slug);
  const [mode, setMode] = useState<"explicit" | "opaque">("explicit");
  const mutation = useMutation({
    mutationFn: async () =>
      unwrapApiResponse(
        await api.organizations.slug.post(
          mode === "opaque"
            ? { type: "opaque" }
            : { type: "explicit", slug: value },
        ),
      ),
    onError: (error) => {
      if (!APIError.is(error) || error.code !== SLUG_CONFLICT_CODE) {
        notifyUserError(error, t("errors.actionFailed"));
      }
    },
    onSuccess: async () => {
      setOpen(false);
      await onSuccess();
    },
  });

  return (
    <>
      <Frame>
        <FramePanel>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="text-sm font-medium">
                {t("settings.organization.slug.title")}
              </h2>
              <bdi className="font-mono text-sm break-all">{slug}</bdi>
            </div>
            {canChange && (
              <Button
                onClick={() => {
                  setValue(slug);
                  setMode("explicit");
                  mutation.reset();
                  setOpen(true);
                }}
                variant="outline"
              >
                {t("settings.organization.slug.change")}
              </Button>
            )}
          </div>
        </FramePanel>
      </Frame>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!mutation.isPending) {
            setOpen(next);
          }
        }}
      >
        <DialogPopup showCloseButton={!mutation.isPending}>
          <DialogHeader>
            <DialogTitle>{t("settings.organization.slug.change")}</DialogTitle>
            <DialogDescription>
              {t("settings.organization.slug.description")}
            </DialogDescription>
          </DialogHeader>
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              if (!mutation.isPending) {
                mutation.mutate();
              }
            }}
          >
            <DialogPanel className="flex flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="organization-slug">
                  {t("settings.organization.slug.title")}
                </FieldLabel>
                <Input
                  autoCapitalize="none"
                  autoCorrect="off"
                  disabled={mode === "opaque" || mutation.isPending}
                  dir="ltr"
                  id="organization-slug"
                  onChange={(event) => {
                    setValue(event.target.value);
                  }}
                  maxLength={ORGANIZATION_SLUG_RULES.maxLength}
                  pattern={ORGANIZATION_SLUG_RULES.pattern.source}
                  required={mode === "explicit"}
                  value={value}
                />
              </Field>
              <Field className="min-h-11 flex-row items-center gap-2">
                <Checkbox
                  checked={mode === "opaque"}
                  disabled={mutation.isPending}
                  onCheckedChange={(checked) => {
                    setMode(checked ? "opaque" : "explicit");
                  }}
                />
                <FieldLabel>
                  {t("settings.organization.slug.opaque")}
                </FieldLabel>
              </Field>
              {APIError.is(mutation.error) &&
                mutation.error.code === SLUG_CONFLICT_CODE && (
                  <p className="text-destructive text-sm" role="alert">
                    {t("settings.organization.slug.conflict")}
                  </p>
                )}
            </DialogPanel>
            <DialogFooter>
              <Button
                disabled={mutation.isPending}
                onClick={() => {
                  setOpen(false);
                }}
                type="button"
                variant="ghost"
              >
                {t("common.cancel")}
              </Button>
              <Button
                disabled={
                  mutation.isPending ||
                  (mode === "explicit" &&
                    (value === slug || value.length === 0))
                }
                loading={mutation.isPending}
                type="submit"
              >
                {t("common.saveChanges")}
              </Button>
            </DialogFooter>
          </Form>
        </DialogPopup>
      </Dialog>
    </>
  );
};
