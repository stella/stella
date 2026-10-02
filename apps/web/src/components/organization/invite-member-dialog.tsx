import { useState } from "react";
import type { ComponentProps } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import type * as v from "valibot";

import { assignableRoles } from "@stll/permissions";
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
import { UserPlusIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { stellaToast } from "@stll/ui/toast";

import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { roleTranslationKeys } from "@/lib/organization/consts";
import { useInviteMember } from "@/lib/organization/mutations";
import {
  inviteMemberSchema,
  roleAssignmentOptions,
} from "@/lib/organization/role-assignment.logic";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";

type InviteMemberDialogProps = {
  buttonLabel?: string;
  buttonSize?: ComponentProps<typeof Button>["size"];
  buttonVariant?: ComponentProps<typeof Button>["variant"];
  description?: string;
  onInvited?: () => void;
  showIcon?: boolean;
};

const defaultValues: v.InferInput<ReturnType<typeof inviteMemberSchema>> = {
  email: "",
  role: "member",
};

export const useCanInviteMembers = () => {
  const { data: currentUserRole } = useQuery({
    ...roleOptions,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return currentUserRole ? assignableRoles(currentUserRole).length > 0 : false;
};

export const InviteMemberDialog = ({
  buttonLabel,
  buttonSize = "sm",
  buttonVariant = "outline",
  description,
  onInvited,
  showIcon = true,
}: InviteMemberDialogProps) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
  const inviteMember = useInviteMember();
  const { data: currentUserRole } = useQuery({
    ...roleOptions,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const roles = roleAssignmentOptions(currentUserRole).map(({ value }) => ({
    description: t(roleTranslationKeys[value].descriptionKey),
    label: t(roleTranslationKeys[value].labelKey),
    value,
  }));

  const form = useForm(
    schemaFormOptions({
      schema: inviteMemberSchema(currentUserRole),
      defaultValues,
      submitValues: "schema-output",
      onSubmit: async ({ value, formApi }) => {
        const inviteResult = await Result.tryPromise(
          async () =>
            await inviteMember.mutateAsync({
              email: value.email,
              role: value.role,
            }),
        );

        if (Result.isError(inviteResult)) {
          const message = userErrorFromThrown(
            inviteResult.error,
            t("errors.actionFailed"),
          );
          formApi.setErrorMap({
            onSubmit: { fields: { email: message } },
          });
          return;
        }

        stellaToast.add({
          title: t("success.invitationSent"),
          type: "success",
        });
        setIsOpen(false);
        onInvited?.();
      },
    }),
  );

  const formErrors = useSelector(form.store, (s) => toFormErrors(s.fieldMeta));

  if (
    currentUserRole === undefined ||
    assignableRoles(currentUserRole).length === 0
  ) {
    return null;
  }

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
      <DialogTrigger
        render={<Button size={buttonSize} variant={buttonVariant} />}
      >
        {showIcon ? <UserPlusIcon className="size-4" /> : null}
        {buttonLabel ?? t("common.invite")}
      </DialogTrigger>
      <DialogPopup>
        <Form
          className="gap-0"
          errors={formErrors}
          onSubmit={(e) => {
            e.preventDefault();
            detached(form.handleSubmit(), "invite-member-dialog.submit");
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t("organization.invitations.inviteMember")}
            </DialogTitle>
            <DialogDescription>
              {description ??
                t("organization.invitations.inviteMemberDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <form.Field name="email">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>
                    {t("organization.invitations.emailAddressLabel")}
                  </FieldLabel>
                  <Input
                    autoFocus
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t(
                      "organization.invitations.emailAddressPlaceholder",
                    )}
                    required
                    type="email"
                    value={field.state.value}
                  />
                  <FieldError />
                </Field>
              )}
            </form.Field>

            <form.Field name="role">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>{t("common.role")}</FieldLabel>
                  <Select
                    items={roles}
                    onValueChange={(val) => {
                      if (val) {
                        field.handleChange(val);
                      }
                    }}
                    value={field.state.value}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("common.selectARole")} />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {roles.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <FieldError />
                </Field>
              )}
            </form.Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </DialogClose>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button loading={isSubmitting} type="submit">
                  {t("organization.invitations.sendInvitation")}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};
