import { useState } from "react";

import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { Result } from "better-result";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { SIGNAL_SEVERITIES } from "@stll/api-contract/signals";
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
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { SEVERITY_LABEL_KEY } from "@/features/inbox/signal-presentation";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { inboxKeys } from "@/lib/inbox/queries";
import { organizationOptions } from "@/lib/organization/queries";
import { toSafeId } from "@/lib/safe-id";
import { toFormErrors } from "@/lib/schema";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

const NONE = "__none__";

const requestSchema = v.strictObject({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(512)),
  description: v.pipe(v.string(), v.trim(), v.maxLength(10_000)),
  workspaceId: v.string(),
  assigneeUserId: v.string(),
  severity: v.picklist(SIGNAL_SEVERITIES),
});

const defaultValues: v.InferInput<typeof requestSchema> = {
  title: "",
  description: "",
  workspaceId: NONE,
  assigneeUserId: NONE,
  severity: "notice",
};

type NewRequestDialogProps = {
  organizationId: string;
};

/** Posts a manual request into the inbox. */
export const NewRequestDialog = ({ organizationId }: NewRequestDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const { data: workspacesData } = useQuery(
    workspacesNavigationOptions(organizationId),
  );
  const { data: organization } = useQuery(organizationOptions(organizationId));
  const workspaces = workspacesData ? workspacesData.workspaces : [];
  const members = organization ? organization.members : [];

  const form = useForm({
    defaultValues,
    validators: { onDynamic: requestSchema },
    onSubmit: async ({ value, formApi }) => {
      const parsed = v.safeParse(requestSchema, value);
      if (!parsed.success) {
        return;
      }
      const { title, description, workspaceId, assigneeUserId, severity } =
        parsed.output;
      const created = await Result.tryPromise(async () =>
        unwrapEden(
          await api.signals.requests.post({
            title,
            description,
            matterId:
              workspaceId === NONE ? null : toSafeId<"workspace">(workspaceId),
            assigneeUserId:
              assigneeUserId === NONE ? null : toSafeId<"user">(assigneeUserId),
            severity,
          }),
        ),
      );
      if (Result.isError(created)) {
        formApi.setErrorMap({
          onSubmit: {
            fields: {
              title: userErrorFromThrown(
                created.error,
                t("errors.actionFailed"),
              ),
            },
          },
        });
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: inboxKeys.all(organizationId),
      });
      stellaToast.add({ title: t("inbox.request.created"), type: "success" });
      formApi.reset();
      setIsOpen(false);
    },
  });
  const formErrors = useSelector(form.store, (s) => toFormErrors(s.fieldMeta));

  const severityItems = SIGNAL_SEVERITIES.map((severity) => ({
    value: severity,
    label: t(SEVERITY_LABEL_KEY[severity]),
  }));
  const workspaceItems = [
    { value: NONE, label: t("common.none") },
    ...workspaces.map((w) => ({ value: w.id, label: w.name })),
  ];
  const memberItems = [
    { value: NONE, label: t("inbox.unassigned") },
    ...members.map((m) => ({ value: m.userId, label: m.user.name })),
  ];

  return (
    <Dialog
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) {
          form.reset();
        }
      }}
      open={isOpen}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <PlusIcon />
        {t("inbox.newRequest")}
      </DialogTrigger>
      <DialogPopup>
        <Form
          className="gap-0"
          errors={formErrors}
          onSubmit={(event) => {
            event.preventDefault();
            detached(form.handleSubmit(), "inbox.submit-request");
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("inbox.newRequest")}</DialogTitle>
            <DialogDescription>
              {t("inbox.request.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <form.Field name="title">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>{t("clauses.titleLabel")}</FieldLabel>
                  <Input
                    autoFocus
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    required
                    value={field.state.value}
                  />
                  <FieldError />
                </Field>
              )}
            </form.Field>
            <form.Field name="description">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>{t("common.description")}</FieldLabel>
                  <Textarea
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    rows={4}
                    value={field.state.value}
                  />
                  <FieldError />
                </Field>
              )}
            </form.Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <form.Field name="workspaceId">
                {(field) => (
                  <Field name={field.name}>
                    <FieldLabel>{t("common.matter")}</FieldLabel>
                    <Select
                      items={workspaceItems}
                      onValueChange={(value) => {
                        if (value) {
                          field.handleChange(value);
                        }
                      }}
                      value={field.state.value}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {workspaceItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Field>
                )}
              </form.Field>
              <form.Field name="assigneeUserId">
                {(field) => (
                  <Field name={field.name}>
                    <FieldLabel>{t("tasks.assigneeRoles.assignee")}</FieldLabel>
                    <Select
                      items={memberItems}
                      onValueChange={(value) => {
                        if (value) {
                          field.handleChange(value);
                        }
                      }}
                      value={field.state.value}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {memberItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Field>
                )}
              </form.Field>
              <form.Field name="severity">
                {(field) => (
                  <Field name={field.name}>
                    <FieldLabel>
                      {t("knowledge.playbooks.severityLabel")}
                    </FieldLabel>
                    <Select
                      items={severityItems}
                      onValueChange={(value) => {
                        if (value) {
                          field.handleChange(value);
                        }
                      }}
                      value={field.state.value}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {severityItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Field>
                )}
              </form.Field>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </DialogClose>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button disabled={isSubmitting} type="submit">
                  {t("inbox.request.submit")}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};
