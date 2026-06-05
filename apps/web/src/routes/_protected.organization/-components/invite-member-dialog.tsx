import { useState } from "react";
import type { ComponentProps } from "react";

import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { Result } from "better-result";
import { UserPlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

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
  DialogTrigger,
} from "@stll/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import { emailSchema, toFormErrors } from "@/lib/schema";
import { roleOptions } from "@/routes/-queries";
import {
  getRoles,
  managementRoles,
  rolePriority,
} from "@/routes/_protected.organization/-consts";
import { useInviteMember } from "@/routes/_protected.organization/-mutations";

type InviteMemberDialogProps = {
  buttonLabel?: string;
  buttonSize?: ComponentProps<typeof Button>["size"];
  buttonVariant?: ComponentProps<typeof Button>["variant"];
  description?: string;
  onInvited?: () => void;
  showIcon?: boolean;
};

const inviteSchema = v.strictObject({
  email: emailSchema(),
  role: v.picklist(["owner", "admin", "member"]),
});

const defaultValues: v.InferInput<typeof inviteSchema> = {
  email: "",
  role: "member",
};

export const useCanInviteMembers = () => {
  const { data: currentUserRole } = useQuery({
    ...roleOptions,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return currentUserRole ? managementRoles.includes(currentUserRole) : false;
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
  const roles = getRoles(t);

  const form = useForm({
    defaultValues,
    validators: { onDynamic: inviteSchema },
    onSubmit: async ({ value, formApi }) => {
      const parseResult = v.safeParse(inviteSchema, value);
      if (!parseResult.success) {
        return;
      }

      const parsedValue = parseResult.output;
      const inviteResult = await Result.tryPromise(
        async () =>
          await inviteMember.mutateAsync({
            email: parsedValue.email,
            role: parsedValue.role,
          }),
      );

      if (Result.isError(inviteResult)) {
        const message =
          inviteResult.error instanceof Error
            ? inviteResult.error.message
            : t("errors.actionFailed");
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
  });

  const formErrors = useSelector(form.store, (s) => toFormErrors(s.fieldMeta));

  if (
    currentUserRole === undefined ||
    !managementRoles.includes(currentUserRole)
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
            // eslint-disable-next-line typescript/no-floating-promises
            form.handleSubmit();
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
                        <SelectItem
                          disabled={
                            rolePriority[item.value] <
                            rolePriority[currentUserRole]
                          }
                          key={item.value}
                          value={item.value}
                        >
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
