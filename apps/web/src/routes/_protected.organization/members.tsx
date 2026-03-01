import { useMemo, useState } from "react";
import { usePostHog } from "@posthog/react";
import { useForm, useStore } from "@tanstack/react-form";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { EllipsisVerticalIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

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
import { Field, FieldError, FieldLabel } from "@stella/ui/components/field";
import { Form } from "@stella/ui/components/form";
import { Frame } from "@stella/ui/components/frame";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stella/ui/components/table";
import { toastManager } from "@stella/ui/components/toast";

import Tooltip from "@/components/tooltip";
import { authClient, type Role } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import { toFormErrors } from "@/lib/schema";
import {
  getRoles,
  rolePriority,
} from "@/routes/_protected.organization/-consts";
import { useRemoveMember } from "@/routes/_protected.organization/-mutations";
import {
  organizationKeys,
  organizationOptions,
} from "@/routes/_protected.organization/-queries";
import { formatDate } from "@/routes/_protected.organization/-utils";
import { roleOptions } from "@/routes/-queries";

export const Route = createFileRoute("/_protected/organization/members")({
  component: Members,
});

function Members() {
  const t = useTranslations();
  const { data } = useSuspenseQuery(organizationOptions);
  const userId = Route.useRouteContext({
    select: (ctx) => ctx.user.id,
  });
  const { q } = useSearch({ from: "/_protected/organization" });

  const filtered = useMemo(() => {
    if (!q) {
      return data.members;
    }
    const query = q.toLowerCase();

    return data.members.filter(
      (m) =>
        m.user.name.toLowerCase().includes(query) ||
        m.user.email.toLowerCase().includes(query),
    );
  }, [data.members, q]);

  const removeMember = useRemoveMember();

  return (
    <Frame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("common.user")}</TableHead>
            <TableHead>{t("common.role")}</TableHead>
            <TableHead>{t("organization.members.joined")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((member) => (
            <TableRow className="group" key={member.id}>
              <TableCell>{member.user.email}</TableCell>
              <TableCell>{t(`organization.roles.${member.role}`)}</TableCell>
              <TableCell>{formatDate(member.createdAt)}</TableCell>
              <TableCell className="text-right">
                <Menu>
                  <Tooltip
                    content={t("common.actions")}
                    render={
                      <MenuTrigger
                        className="opacity-0! transition-opacity group-hover:opacity-100!"
                        disabled={member.userId === userId}
                        render={<Button size="icon-xs" variant="ghost" />}
                      />
                    }
                  >
                    <EllipsisVerticalIcon />
                  </Tooltip>
                  <MenuPopup>
                    <UpdateRoleDialog
                      email={member.user.email}
                      memberId={member.id}
                      role={member.role}
                    />
                    <MenuItem
                      disabled={removeMember.isPending}
                      onClick={() => removeMember.mutate(member.id)}
                      variant="destructive"
                    >
                      {t("organization.members.removeMember")}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell
                className="text-center text-muted-foreground"
                colSpan={4}
              >
                {t("organization.members.noMembersFound")}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Frame>
  );
}

const updateRoleSchema = v.object({
  role: v.picklist(["owner", "admin", "member"]),
});

type UpdateRoleDialogProps = {
  memberId: string;
  email: string;
  role: Role;
};
const UpdateRoleDialog = ({ memberId, email, role }: UpdateRoleDialogProps) => {
  const t = useTranslations();
  const posthog = usePostHog();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const { data: currentUserRole } = useSuspenseQuery(roleOptions);

  const roles = getRoles(t);

  const form = useForm({
    defaultValues: { role },
    validators: { onDynamic: updateRoleSchema },
    onSubmit: async ({ value }) => {
      const result = await authClient.organization.updateMemberRole({
        memberId,
        role: value.role,
      });

      if (result.error) {
        captureError(posthog, toAuthClientError(result.error));
        toastManager.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
      toastManager.add({ title: t("success.roleUpdated"), type: "success" });
      setIsOpen(false);
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

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
        disabled={rolePriority[role] < rolePriority[currentUserRole]}
        nativeButton={false}
        render={<MenuItem closeOnClick={false} />}
      >
        {t("organization.members.changeRole")}
      </DialogTrigger>
      <DialogPopup>
        <Form
          className="gap-0"
          errors={formErrors}
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("organization.members.changeRole")}</DialogTitle>
            <DialogDescription>
              {t("organization.members.changeRoleDescription", { email })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <form.Field name="role">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>{t("common.role")}</FieldLabel>
                  <Select
                    items={roles}
                    onValueChange={(value) => {
                      if (value) {
                        field.handleChange(value);
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
                <Button disabled={isSubmitting} type="submit">
                  {t("organization.members.updateRole")}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};
