import { useState } from "react";

import { useForm, useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BuildingIcon,
  EllipsisVerticalIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
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
import { Input } from "@stella/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stella/ui/components/input-group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
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
import { usePermissions } from "@/hooks/use-permissions";
import { pageTitle } from "@/lib/page-title";
import { toFormErrors } from "@/lib/schema";
import {
  useCreateContact,
  useDeleteContact,
} from "@/routes/_protected.contacts/-mutations";
import {
  contactsKeys,
  contactsOptions,
} from "@/routes/_protected.contacts/-queries";

type ContactFilter = "all" | "person" | "organization";

export const Route = createFileRoute("/_protected/contacts/")({
  head: () => ({
    meta: [{ title: pageTitle("navigation.contacts") }],
  }),
  component: ContactsPage,
});

function ContactsPage() {
  const t = useTranslations();
  const canCreateContact = usePermissions({ contact: ["create"] });
  const [filter, setFilter] = useState<ContactFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const updateSearch = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value);
  }, 300);

  const typeFilter = filter === "all" ? undefined : filter;

  const { data, isLoading } = useQuery(
    contactsOptions({
      type: typeFilter,
      q: debouncedQuery || undefined,
    }),
  );

  const items = data?.items ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t p-4">
      <div className="flex items-center gap-2">
        <InputGroup className="me-auto max-w-sm flex-1">
          <InputGroupInput
            onChange={(e) => {
              const val = e.target.value;
              setSearchQuery(val);
              updateSearch(val);
            }}
            placeholder={t("contacts.search")}
            value={searchQuery}
          />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
        <div className="flex gap-1">
          <FilterButton
            active={filter === "all"}
            label={t("common.all")}
            onClick={() => setFilter("all")}
          />
          <FilterButton
            active={filter === "person"}
            label={t("contacts.filterPersons")}
            onClick={() => setFilter("person")}
          />
          <FilterButton
            active={filter === "organization"}
            label={t("contacts.filterOrganizations")}
            onClick={() => setFilter("organization")}
          />
        </div>
        {canCreateContact && <CreateContactDialog />}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>{t("common.name")}</TableHead>
            <TableHead>{t("common.email")}</TableHead>
            <TableHead>{t("contacts.columns.phone")}</TableHead>
            <TableHead className="text-end">{t("common.matters")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((contact) => (
            <ContactRow contact={contact} key={contact.id} />
          ))}
          {!isLoading && items.length === 0 && (
            <TableRow>
              <TableCell
                className="text-muted-foreground py-8 text-center"
                colSpan={6}
              >
                <p>{t("contacts.noContactsFound")}</p>
                <p className="text-sm">{t("contacts.noContactsDescription")}</p>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

type FilterButtonProps = {
  label: string;
  active: boolean;
  onClick: () => void;
};

const FilterButton = ({ label, active, onClick }: FilterButtonProps) => (
  <Button onClick={onClick} size="sm" variant={active ? "default" : "outline"}>
    {label}
  </Button>
);

type ContactItem = {
  id: string;
  type: "person" | "organization";
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  emails: { type: string; address: string; isPrimary: boolean }[] | null;
  phones: { type: string; number: string; isPrimary: boolean }[] | null;
  tags: string[] | null;
  color: string | null;
  createdAt: Date;
  matterCount: number;
};

const ContactRow = ({ contact }: { contact: ContactItem }) => {
  const t = useTranslations();
  const canDeleteContact = usePermissions({ contact: ["delete"] });
  const deleteContact = useDeleteContact();
  const queryClient = useQueryClient();

  const primaryEmail =
    contact.emails?.find((e) => e.isPrimary) ?? contact.emails?.at(0);

  const primaryPhone =
    contact.phones?.find((p) => p.isPrimary) ?? contact.phones?.at(0);

  const handleDelete = () => {
    deleteContact.mutate(
      { contactId: contact.id },
      {
        onSuccess: () => {
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: contactsKeys.all,
          });
          toastManager.add({
            title: t("success.contactDeleted"),
            type: "success",
          });
        },
        onError: (error) => {
          toastManager.add({
            title:
              error instanceof Error ? error.message : t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <TableRow className="group">
      <TableCell>
        {contact.type === "person" ? (
          <UserIcon className="text-muted-foreground size-4" />
        ) : (
          <BuildingIcon className="text-muted-foreground size-4" />
        )}
      </TableCell>
      <TableCell>
        <Link
          className="font-medium hover:underline"
          params={{ contactId: contact.id }}
          to="/contacts/$contactId"
        >
          {contact.displayName}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {primaryEmail?.address}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {primaryPhone?.number}
      </TableCell>
      <TableCell className="text-end tabular-nums">
        {contact.matterCount}
      </TableCell>
      <TableCell className="w-10 text-end">
        <Menu>
          <Tooltip
            content={t("common.actions")}
            render={
              <MenuTrigger
                className="opacity-0! transition-opacity group-hover:opacity-100!"
                render={<Button size="icon-xs" variant="ghost" />}
              />
            }
          >
            <EllipsisVerticalIcon />
          </Tooltip>
          <MenuPopup>
            {canDeleteContact && (
              <MenuItem
                disabled={deleteContact.isPending}
                onClick={handleDelete}
                variant="destructive"
              >
                {t("contacts.deleteContact")}
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      </TableCell>
    </TableRow>
  );
};

const trimmedString = (maxLength: number) =>
  v.pipe(v.string(), v.trim(), v.maxLength(maxLength));

const requiredTrimmedString = (maxLength: number, message: string) =>
  v.pipe(v.string(), v.trim(), v.nonEmpty(message), v.maxLength(maxLength));

const createContactSchema = (requiredMessage: string) =>
  v.pipe(
    v.strictObject({
      type: v.picklist(["person", "organization"]),
      displayName: requiredTrimmedString(512, requiredMessage),
      firstName: trimmedString(256),
      lastName: trimmedString(256),
      organizationName: trimmedString(512),
    }),
    v.forward(
      v.partialCheck(
        [["type"], ["organizationName"]],
        ({ type, organizationName }) =>
          type !== "organization" || organizationName.length > 0,
        requiredMessage,
      ),
      ["organizationName"],
    ),
  );

const CreateContactDialog = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const createContact = useCreateContact();
  const schema = createContactSchema(t("common.required"));

  const form = useForm({
    defaultValues: {
      // SAFETY: widening literal for form discriminant union
      // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
      type: "person" as "person" | "organization",
      displayName: "",
      firstName: "",
      lastName: "",
      organizationName: "",
    },
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      const result = v.safeParse(schema, value);
      if (!result.success) {
        return;
      }
      const parsedValue = result.output;
      const firstName =
        parsedValue.type === "person"
          ? parsedValue.firstName || undefined
          : undefined;
      const lastName =
        parsedValue.type === "person"
          ? parsedValue.lastName || undefined
          : undefined;
      const organizationName =
        parsedValue.type === "organization"
          ? parsedValue.organizationName || undefined
          : undefined;

      await createContact.mutateAsync({
        id: crypto.randomUUID(),
        type: parsedValue.type,
        displayName: parsedValue.displayName,
        ...(firstName && { firstName }),
        ...(lastName && { lastName }),
        ...(organizationName && { organizationName }),
      });

      await queryClient.invalidateQueries({
        queryKey: contactsKeys.all,
      });
      toastManager.add({
        title: t("success.contactCreated"),
        type: "success",
      });
      setIsOpen(false);
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

  const contactType = useStore(form.store, (s) => s.values.type);

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
        {t("contacts.newContact")}
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
            <DialogTitle>{t("contacts.newContact")}</DialogTitle>
            <DialogDescription />
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <form.Field name="type">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>{t("common.type")}</FieldLabel>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => {
                        field.handleChange("person");
                        form.setFieldValue("displayName", "");
                      }}
                      size="sm"
                      type="button"
                      variant={
                        field.state.value === "person" ? "default" : "outline"
                      }
                    >
                      <UserIcon className="size-4" />
                      {t("contacts.type.person")}
                    </Button>
                    <Button
                      onClick={() => {
                        field.handleChange("organization");
                        form.setFieldValue("displayName", "");
                      }}
                      size="sm"
                      type="button"
                      variant={
                        field.state.value === "organization"
                          ? "default"
                          : "outline"
                      }
                    >
                      <BuildingIcon className="size-4" />
                      {t("contacts.type.organization")}
                    </Button>
                  </div>
                  <FieldError />
                </Field>
              )}
            </form.Field>

            {contactType === "person" && (
              <>
                <form.Field name="firstName">
                  {(field) => (
                    <Field name={field.name}>
                      <FieldLabel>{t("contacts.fields.firstName")}</FieldLabel>
                      <Input
                        autoFocus
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          const val = e.target.value;
                          field.handleChange(val);
                          const last = form.state.values.lastName;
                          form.setFieldValue(
                            "displayName",
                            [val, last].filter(Boolean).join(" "),
                          );
                        }}
                        value={field.state.value}
                      />
                      <FieldError />
                    </Field>
                  )}
                </form.Field>
                <form.Field name="lastName">
                  {(field) => (
                    <Field name={field.name}>
                      <FieldLabel>{t("contacts.fields.lastName")}</FieldLabel>
                      <Input
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          const val = e.target.value;
                          field.handleChange(val);
                          const first = form.state.values.firstName;
                          form.setFieldValue(
                            "displayName",
                            [first, val].filter(Boolean).join(" "),
                          );
                        }}
                        value={field.state.value}
                      />
                      <FieldError />
                    </Field>
                  )}
                </form.Field>
              </>
            )}

            {contactType === "organization" && (
              <form.Field name="organizationName">
                {(field) => (
                  <Field name={field.name}>
                    <FieldLabel>{t("common.organizationName")}</FieldLabel>
                    <Input
                      autoFocus
                      onBlur={field.handleBlur}
                      onChange={(e) => {
                        field.handleChange(e.target.value);
                        form.setFieldValue("displayName", e.target.value);
                      }}
                      value={field.state.value}
                    />
                    <FieldError />
                  </Field>
                )}
              </form.Field>
            )}

            <form.Field name="displayName">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>{t("contacts.fields.displayName")}</FieldLabel>
                  <Input
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    value={field.state.value}
                  />
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
                  {t("common.save")}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};
