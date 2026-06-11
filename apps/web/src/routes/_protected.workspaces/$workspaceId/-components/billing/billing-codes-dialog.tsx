import { useState } from "react";

import { useForm } from "@tanstack/react-form";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { PlusIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Dialog, DialogPopup } from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import { Tabs, TabsList, TabsTab } from "@stll/ui/components/tabs";
import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import {
  billingCodesKeys,
  billingCodesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/billing-codes";

type BillingCodesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
};

export const BillingCodesDialog = ({
  open,
  onOpenChange,
  workspaceId,
}: BillingCodesDialogProps) => {
  const t = useTranslations();
  const [activeTab, setActiveTab] = useState<"task" | "activity">("task");
  const [showForm, setShowForm] = useState(false);

  const { data: codes } = useSuspenseQuery(
    billingCodesOptions(workspaceId, activeTab),
  );
  const analytics = useAnalytics();

  const createCode = useMutation({
    mutationFn: async ({
      workspaceId: ws,
      ...body
    }: {
      workspaceId: string;
      type: "task" | "activity";
      code: string;
      label: string;
      active?: boolean;
      sortOrder?: number;
    }) => {
      const response = await api["billing-codes"]({
        workspaceId: toSafeId<"workspace">(ws),
      }).put({
        queryKey: billingCodesKeys.all(ws),
        ...body,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
  const deleteCode = useMutation({
    mutationFn: async ({
      workspaceId: ws,
      id,
    }: {
      workspaceId: string;
      id: string;
    }) => {
      const response = await api["billing-codes"]({
        workspaceId: toSafeId<"workspace">(ws),
      }).delete({
        queryKey: billingCodesKeys.all(ws),
        id: toSafeId<"billingCode">(id),
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
  const updateCode = useMutation({
    mutationFn: async ({
      workspaceId: ws,
      ...body
    }: {
      workspaceId: string;
      id: string;
      code?: string;
      label?: string;
      active?: boolean;
      sortOrder?: number;
    }) => {
      const response = await api["billing-codes"]({
        workspaceId: toSafeId<"workspace">(ws),
      }).patch({
        queryKey: billingCodesKeys.all(ws),
        ...body,
        id: toSafeId<"billingCode">(body.id),
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  const handleDelete = (id: string) => {
    deleteCode.mutate(
      { workspaceId, id },
      {
        onError: () => {
          stellaToast.add({
            title: t("common.somethingWentWrong"),
            type: "error",
          });
        },
      },
    );
  };

  const handleToggleActive = (id: string, active: boolean) => {
    updateCode.mutate(
      { workspaceId, id, active: !active },
      {
        onError: () => {
          stellaToast.add({
            title: t("common.somethingWentWrong"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-lg">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between pe-6">
            <h3 className="text-sm font-medium">
              {t("billing.codes.manageCodes")}
            </h3>
          </div>

          <Tabs
            onValueChange={(v: typeof activeTab) => {
              setActiveTab(v);
              setShowForm(false);
            }}
            value={activeTab}
          >
            <TabsList>
              <TabsTab value="task">{t("billing.codes.task")}</TabsTab>
              <TabsTab value="activity">{t("billing.codes.activity")}</TabsTab>
            </TabsList>
          </Tabs>

          <Button
            className="self-end"
            onClick={() => setShowForm(!showForm)}
            size="sm"
            variant="outline"
          >
            <PlusIcon className="size-4" />
            {t("billing.codes.createCode")}
          </Button>

          {showForm && (
            <CreateCodeForm
              onCancel={() => setShowForm(false)}
              onSubmit={(values) => {
                createCode.mutate(
                  {
                    workspaceId,
                    type: activeTab,
                    ...values,
                  },
                  {
                    onSuccess: () => setShowForm(false),
                    onError: () => {
                      stellaToast.add({
                        title: t("common.somethingWentWrong"),
                        type: "error",
                      });
                    },
                  },
                );
              }}
            />
          )}

          {codes.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {codes.map((code) => (
                <div
                  className="group flex items-center gap-3 rounded-md border px-3 py-2"
                  key={code.id}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="text-muted-foreground shrink-0 font-mono text-xs">
                      {code.code}
                    </span>
                    <span className="truncate text-sm">{code.label}</span>
                    {!code.active && (
                      <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[0.625rem]">
                        {t("billing.codes.inactive")}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      className="size-7"
                      onClick={() => handleToggleActive(code.id, code.active)}
                      size="icon"
                      title={
                        code.active
                          ? t("billing.codes.inactive")
                          : t("billing.codes.active")
                      }
                      variant="ghost"
                    >
                      <Checkbox checked={code.active} />
                    </Button>
                    <Button
                      className="text-destructive size-7"
                      onClick={() => handleDelete(code.id)}
                      size="icon"
                      variant="ghost"
                    >
                      <TrashIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            !showForm && (
              <div className="text-muted-foreground py-6 text-center text-sm">
                {t("billing.codes.noCodesYet")}
              </div>
            )
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
};

const CreateCodeForm = ({
  onSubmit,
  onCancel,
}: {
  onSubmit: (values: { code: string; label: string }) => void;
  onCancel: () => void;
}) => {
  const t = useTranslations();

  const form = useForm({
    defaultValues: { code: "", label: "" },
    onSubmit: ({ value }) => {
      if (!value.code.trim() || !value.label.trim()) {
        return;
      }
      onSubmit(value);
    },
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <div className="flex gap-3">
        <div className="w-24">
          <Label>{t("billing.codes.codeLabel")}</Label>
          <form.Field name="code">
            {(field) => (
              <Input
                autoFocus
                maxLength={20}
                onChange={(e) => field.handleChange(e.currentTarget.value)}
                placeholder="L110"
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
        <div className="flex-1">
          <Label>{t("billing.codes.codeLabelField")}</Label>
          <form.Field name="label">
            {(field) => (
              <Input
                maxLength={256}
                onChange={(e) => field.handleChange(e.currentTarget.value)}
                placeholder="Research"
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" type="button" variant="outline">
          {t("common.cancel")}
        </Button>
        <Button size="sm" type="submit">
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
};
