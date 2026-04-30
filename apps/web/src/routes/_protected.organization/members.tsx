import { useMemo, useState } from "react";

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
import { Frame } from "@stll/ui/components/frame";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { toastManager } from "@stll/ui/components/toast";
import { useForm, useStore } from "@tanstack/react-form";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { EllipsisVerticalIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import Tooltip from "@/components/tooltip";
import { UserIdentity } from "@/components/user-avatar";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { toFormErrors } from "@/lib/schema";
import { roleOptions } from "@/routes/-queries";
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

export const Route = createFileRoute("/_protected/organization/members")({
  component: Members,
});

function Members() {
  const t = useTranslations();
  const { data } = useSuspenseQuery(organizationOptions);
  const userId = Route.useRouteContext({
    select: (ctx) => ctx.user.id,
  });
  const q = useSearch({ from: "/_protected/organization", select: (s) => s.q });

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
              <TableCell>
                <UserIdentity
                  avatarClassName="size-8 shrink-0 text-[0.625rem]"
                  image={member.user.image}
                  name={member.user.name}
                  secondaryText={member.user.email}
                />
              </TableCell>
              <TableCell>{t(`organization.roles.${member.role}`)}</TableCell>
              <TableCell>{formatDate(member.createdAt)}</TableCell>
              <TableCell className="text-end">
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
                className="text-muted-foreground text-center"
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

const updateRoleSchema = v.strictObject({
  role: v.picklist(["owner", "admin", "member"]),
});

type UpdateRoleDialogProps = {
  memberId: string;
  email: string;
  role: Role;
};
const UpdateRoleDialog = ({ memberId, email, role }: UpdateRoleDialogProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const { data: currentUserRole } = useSuspenseQuery(roleOptions);

  const roles = getRoles(t);

  const form = useForm({
    defaultValues: { role },
    validators: { onDynamic: updateRoleSchema },
    onSubmit: async ({ value }) => {
      const parseResult = v.safeParse(updateRoleSchema, value);
      if (!parseResult.success) {
        return;
      }
      const parsedValue = parseResult.output;
      const result = await authClient.organization.updateMemberRole({
        memberId,
        role: parsedValue.role,
      });

      if (result.error) {
        analytics.captureError(toAuthClientError(result.error));
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
            // eslint-disable-next-line typescript/no-floating-promises
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
                <Button loading={isSubmitting} type="submit">
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
