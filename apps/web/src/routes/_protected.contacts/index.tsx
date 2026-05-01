import { useState } from "react";

import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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

import Tooltip from "@/components/tooltip";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { pageTitle } from "@/lib/page-title";
import { toSafeId } from "@/lib/safe-id";
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
  const navigate = useNavigate();
  const canDeleteContact = usePermissions({ contact: ["delete"] });
  const deleteContact = useDeleteContact();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const primaryEmail =
    contact.emails?.find((e) => e.isPrimary) ?? contact.emails?.at(0);

  const primaryPhone =
    contact.phones?.find((p) => p.isPrimary) ?? contact.phones?.at(0);

  const openContact = () => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    navigate({
      to: "/contacts/$contactId",
      params: { contactId: contact.id },
    });
  };

  const handleDelete = async () => {
    await deleteContact.mutateAsync(
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
    <TableRow
      className="hover:bg-accent/30 focus-visible:ring-ring group cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset"
      onClick={openContact}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openContact();
        }
      }}
      tabIndex={0}
    >
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
          onClick={(event) => event.stopPropagation()}
          params={{ contactId: contact.id }}
          to="/contacts/$contactId"
        >
          {contact.displayName}
        </Link>
      </TableCell>
      <TableCell
        className="text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        {primaryEmail && (
          <a
            className="hover:text-foreground hover:underline"
            href={`mailto:${primaryEmail.address}`}
          >
            {primaryEmail.address}
          </a>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {primaryPhone?.number}
      </TableCell>
      <TableCell className="text-end tabular-nums">
        {contact.matterCount}
      </TableCell>
      <TableCell
        className="w-10 text-end"
        onClick={(event) => event.stopPropagation()}
      >
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
                onClick={() => setDeleteOpen(true)}
                variant="destructive"
              >
                {t("contacts.deleteContact")}
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
        <DestructiveConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          confirmation={contact.displayName}
          description={t("contacts.deleteContactConfirmDescription")}
          inputLabel={t("common.typeNameToConfirm")}
          loading={deleteContact.isPending}
          onConfirm={handleDelete}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
          title={t("contacts.deleteContact")}
        />
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
      registrationNumber: trimmedString(64),
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

type BillingAddress = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

type AresAddress = {
  street: string | null;
  houseNumber: string | null;
  orientationNumber: string | null;
  orientationLetter: string | null;
  municipalityPart: string | null;
  municipality: string | null;
  postalCode: string | null;
  district: string | null;
  country: string | null;
  textAddress: string | null;
};

const normalizeIcoInput = (value: string) => value.replaceAll(/\D/g, "");

const formatStreetLine = (address: AresAddress) => {
  const street = address.street ?? address.municipalityPart ?? "";
  const houseNumber = address.houseNumber ?? "";
  const orientationNumber = address.orientationNumber
    ? `/${address.orientationNumber}${address.orientationLetter ?? ""}`
    : "";

  return [street, `${houseNumber}${orientationNumber}`.trim()]
    .filter(Boolean)
    .join(" ");
};

const toBillingAddress = (
  address: AresAddress | null,
): BillingAddress | null => {
  if (!address) {
    return null;
  }

  const line1 = formatStreetLine(address) || address.textAddress || undefined;

  return {
    ...(line1 && { line1 }),
    ...(address.municipality && { city: address.municipality }),
    ...(address.district && { state: address.district }),
    ...(address.postalCode && { postalCode: address.postalCode }),
    ...(address.country && { country: address.country }),
  };
};

const CreateContactDialog = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [isAresLoading, setIsAresLoading] = useState(false);
  const [aresBillingAddress, setAresBillingAddress] =
    useState<BillingAddress | null>(null);
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
      registrationNumber: "",
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
      const registrationNumber =
        parsedValue.type === "organization"
          ? parsedValue.registrationNumber || undefined
          : undefined;

      await createContact.mutateAsync({
        id: toSafeId<"contact">(crypto.randomUUID()),
        type: parsedValue.type,
        displayName: parsedValue.displayName,
        ...(firstName && { firstName }),
        ...(lastName && { lastName }),
        ...(organizationName && { organizationName }),
        ...(registrationNumber && { registrationNumber }),
        ...(parsedValue.type === "organization" &&
          aresBillingAddress && { billingAddress: aresBillingAddress }),
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

  const handleAresLookup = async () => {
    const ico = normalizeIcoInput(form.state.values.registrationNumber);

    if (ico.length !== 8) {
      toastManager.add({
        title: t("contacts.create.invalidIco"),
        type: "error",
      });
      return;
    }

    setIsAresLoading(true);
    try {
      const response = await api.contacts.ares.get({ query: { ico } });
      if (response.error) {
        throw toAPIError(response.error);
      }

      const company =
        response.data.type === "lookup" ? response.data.company : null;

      if (!company) {
        toastManager.add({
          title: t("contacts.create.aresNotFound"),
          type: "error",
        });
        return;
      }

      form.setFieldValue("registrationNumber", company.ico);
      form.setFieldValue("organizationName", company.name);
      form.setFieldValue("displayName", company.name);
      setAresBillingAddress(toBillingAddress(company.address));

      toastManager.add({
        title: t("contacts.create.aresApplied"),
        type: "success",
      });
    } catch (error) {
      toastManager.add({
        title:
          error instanceof Error ? error.message : t("errors.actionFailed"),
        type: "error",
      });
    } finally {
      setIsAresLoading(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) {
          form.reset();
          setAresBillingAddress(null);
          setIsAresLoading(false);
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
                        setAresBillingAddress(null);
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
              <>
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

                <div className="bg-muted/20 flex flex-col gap-3 rounded-md border p-3">
                  <div>
                    <p className="text-sm font-medium">
                      {t("contacts.create.aresTitle")}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t("contacts.create.aresHint")}
                    </p>
                  </div>
                  <form.Field name="registrationNumber">
                    {(field) => (
                      <Field name={field.name}>
                        <div className="flex gap-2">
                          <Input
                            inputMode="numeric"
                            onBlur={field.handleBlur}
                            onChange={(e) => {
                              field.handleChange(
                                normalizeIcoInput(e.target.value),
                              );
                              setAresBillingAddress(null);
                            }}
                            placeholder={t("contacts.create.icoPlaceholder")}
                            value={field.state.value}
                          />
                          <Button
                            loading={isAresLoading}
                            onClick={() => {
                              void handleAresLookup();
                            }}
                            type="button"
                            variant="outline"
                          >
                            {t("contacts.create.aresLookup")}
                          </Button>
                        </div>
                        <FieldError />
                      </Field>
                    )}
                  </form.Field>
                  {aresBillingAddress?.line1 && (
                    <p className="text-muted-foreground text-xs">
                      {[
                        aresBillingAddress.line1,
                        aresBillingAddress.city,
                        aresBillingAddress.postalCode,
                        aresBillingAddress.country,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  )}
                </div>
              </>
            )}

            <form.Field name="displayName">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>{t("contacts.create.contactName")}</FieldLabel>
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
