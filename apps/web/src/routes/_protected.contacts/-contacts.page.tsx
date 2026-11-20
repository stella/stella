import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  createCoreRowModel,
  flexRender,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { ReactTable, Row } from "@tanstack/react-table";
import { panic, Result } from "better-result";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { CONTACT_TYPES, type ContactType } from "@stll/api-contract";
import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import {
  BuildingIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  PlusIcon,
  UploadIcon,
  UserIcon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { SearchField } from "@stll/ui/search-field";
import { TableCell, TableRow } from "@stll/ui/table";
import { stellaToast } from "@stll/ui/toast";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { ContactReadError } from "@/components/contact-read-error";
import { EmptyScreen } from "@/components/empty-screen";
import Tooltip from "@/components/tooltip";
import { usePermissions } from "@/hooks/use-permissions";
import { useSingleFlight } from "@/hooks/use-single-flight";
import { useFormatter } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useCreateContact, useDeleteContact } from "@/lib/contacts/mutations";
import { contactsKeys, contactsOptions } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import type { QueryView } from "@/lib/query-view.logic";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";
import { useQueryViewError } from "@/lib/use-query-view";
import { downloadFile } from "@/lib/utils";
import { BulkDeleteContacts } from "@/routes/_protected.contacts/-components/bulk-delete";
import { ContactNameLink } from "@/routes/_protected.contacts/-components/contact-name-link";
import { PersonDetailsFields } from "@/routes/_protected.contacts/-components/person-details-fields";
import {
  birthDateDraft,
  parseBirthDateDraft,
} from "@/routes/_protected.contacts/-components/person-details-fields.logic";
import type { BirthDateDraft } from "@/routes/_protected.contacts/-components/person-details-fields.logic";
import {
  ProcuracaoDropZone,
  ProcuracaoReview,
  useProcuracaoExtraction,
} from "@/routes/_protected.contacts/-procuracao-extraction";

import {
  CONTACT_FILTERS,
  contactColumns,
  contactFilterButton,
  CONTACTS_TOOLBAR_BUTTON_SIZE,
  ContactsShell,
  ContactsSkeletonRows,
  ContactsTableFrame,
  ContactsToolbar,
  ContactsToolbarButtonContent,
} from "./-contacts.pending";
import type {
  ContactColumn,
  ContactColumnId,
  ContactFilter,
} from "./-contacts.pending";

const ARES_NATIVE_TOOL_SLUG = "ares";

/** The contacts search, in the box its pending face reserves. */
const ContactsSearchField = ({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) => {
  const t = useTranslations();
  return (
    <SearchField
      aria-label={t("contacts.search")}
      clearLabel={t("common.clearSearch")}
      // The width the pending face reserves.
      groupClassName="sm:max-w-sm"
      maxLength={SEARCH_QUERY_MAX_LENGTH}
      onValueChange={onValueChange}
      placeholder={t("contacts.search")}
      value={value}
    />
  );
};

/** The type filters, as their pending faces draw them. */
const ContactFilterButtons = ({
  filter,
  onFilterChange,
}: {
  filter: ContactFilter;
  onFilterChange: (filter: ContactFilter) => void;
}) => {
  const t = useTranslations();
  return CONTACT_FILTERS.map(({ filter: option, labelKey }) => {
    const active = filter === option;
    const button = contactFilterButton(active);
    return (
      <Button
        aria-pressed={active}
        key={option}
        onClick={() => onFilterChange(option)}
        size={button.size}
        variant={button.variant}
      >
        {t(labelKey)}
      </Button>
    );
  });
};

/** A toolbar action: its icon, with the label beside it from `sm` up. */
const ContactsToolbarButton = ({
  icon,
  label,
  ...props
}: {
  icon: ReactNode;
  label: string;
} & Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "size" | "title"
>) => (
  <Button
    {...props}
    aria-label={label}
    size={CONTACTS_TOOLBAR_BUTTON_SIZE}
    title={label}
  >
    <ContactsToolbarButtonContent icon={icon} label={label} />
  </Button>
);

const EMPTY_CONTACTS: ContactItem[] = [];

const protectedRouteApi = getRouteApi("/_protected");

/** /contacts: the organization's contacts, searchable and filterable by type. */
export function ContactsPage() {
  const t = useTranslations();
  const tContacts = useTranslations("contacts");
  const canCreateContact = usePermissions({ contact: ["create"] });
  const canDeleteContact = usePermissions({ contact: ["delete"] });
  const [createContactOpen, setCreateContactOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [filter, setFilter] = useState<ContactFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);

  const updateSearch = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value);
  }, 300);

  // A selection the new filter hides must not be deleted unseen.
  const changeFilter = (next: ContactFilter) => {
    setFilter(next);
    setSelectedIds([]);
  };

  const typeFilter = filter === "all" ? undefined : filter;
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const contactsQuery = useInfiniteQuery(
    contactsOptions(activeOrganizationId, {
      type: typeFilter,
      q: debouncedQuery || undefined,
    }),
  );
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = contactsQuery;
  const view = queryView(contactsQuery, {
    isEmpty: (data) => data.pages.every((page) => page.items.length === 0),
  });
  const items = (() => {
    switch (view.type) {
      case "items":
        return view.items.pages.flatMap((page) => page.items);
      case "pending":
      case "error":
      case "empty":
        return EMPTY_CONTACTS;
      default:
        view satisfies never;
        return panic("Unhandled contacts query state");
    }
  })();
  const isFirstUseEmpty =
    view.type === "empty" && searchQuery.trim() === "" && filter === "all";

  const columns = contactColumns(canDeleteContact);
  const columnDefs = contactColumnDefs({
    columns,
    selectedIds,
    setSelectedIds,
  });

  const table = useTable({
    features: contactTableFeatures,
    data: items,
    columns: columnDefs,
    getRowId: (row) => row.id,
  });

  const handleExport = async () => {
    setIsExporting(true);
    const result = await Result.tryPromise(async () => {
      const response = await api.contacts.export.get({
        query: { format: "csv" },
      });
      const exportData = unwrapApiResponse(response);
      return exportData instanceof Response
        ? await exportData.blob()
        : new Blob([String(exportData)], { type: "text/csv;charset=utf-8" });
    });
    setIsExporting(false);

    if (Result.isError(result)) {
      notifyUserError(result.error, t("contacts.exportFailed"));
      return;
    }

    downloadFile(result.value, "contacts-export.csv");
  };

  return (
    <ContactsShell>
      {canDeleteContact && (
        <BulkDeleteContacts
          contactIds={selectedIds}
          onResolved={(resolvedIds) =>
            setSelectedIds((currentIds) =>
              currentIds.filter(
                (contactId) => !resolvedIds.includes(contactId),
              ),
            )
          }
          organizationId={activeOrganizationId}
        />
      )}
      <ContactsToolbar
        actions={
          <>
            {canCreateContact && (
              <ContactsToolbarButton
                icon={<UploadIcon />}
                label={t("common.import")}
                render={<Link to="/contacts/import" />}
                variant="outline"
              />
            )}
            <ContactsToolbarButton
              aria-busy={isExporting}
              disabled={isExporting}
              icon={<DownloadIcon />}
              label={t("workspaces.views.exportCsv")}
              onClick={() => {
                detached(handleExport(), "contacts-page.export");
              }}
              variant="outline"
            />
            {canCreateContact && (
              <>
                <ContactsToolbarButton
                  icon={<PlusIcon />}
                  label={t("contacts.newContact")}
                  onClick={() => setCreateContactOpen(true)}
                />
                <CreateContactDialog
                  onOpenChange={setCreateContactOpen}
                  open={createContactOpen}
                />
              </>
            )}
          </>
        }
        filters={
          <ContactFilterButtons filter={filter} onFilterChange={changeFilter} />
        }
        search={
          <ContactsSearchField
            onValueChange={(value) => {
              setSearchQuery(value);
              updateSearch(value);
              // A selection the new results hide must not be deleted unseen.
              setSelectedIds([]);
            }}
            value={searchQuery}
          />
        }
      />

      {isFirstUseEmpty && canCreateContact ? (
        <EmptyScreen
          description={tContacts("emptyDescription")}
          primaryAction={{
            label: tContacts("newContact"),
            icon: PlusIcon,
            onClick: () => setCreateContactOpen(true),
          }}
          title={tContacts("emptyTitle")}
        />
      ) : (
        <>
          {(() => {
            switch (view.type) {
              case "pending":
                return (
                  <ContactsTable
                    columns={columns}
                    state="pending"
                    table={table}
                  />
                );
              case "error":
                return (
                  <ContactsTable
                    columns={columns}
                    state="error"
                    table={table}
                    notice={
                      <ContactReadError
                        error={view.error}
                        onRetry={() =>
                          detached(view.retry(), "contacts-page.retry")
                        }
                      />
                    }
                  />
                );
              case "empty":
                return (
                  <ContactsTable
                    columns={columns}
                    state="empty"
                    table={table}
                  />
                );
              case "items":
                return (
                  <ContactsTable
                    columns={columns}
                    state="items"
                    table={table}
                    notice={
                      view.refetchError !== undefined ? (
                        <ContactReadError
                          error={view.refetchError}
                          onRetry={() =>
                            detached(view.retry(), "contacts-page.retry")
                          }
                        />
                      ) : undefined
                    }
                  />
                );
              default:
                view satisfies never;
                return panic("Unhandled contacts query state");
            }
          })()}
          {hasNextPage && (
            <Button
              className="self-center"
              loading={isFetchingNextPage}
              onClick={() => {
                const request = fetchNextPage().then((result) => {
                  if (result.isError) {
                    notifyUserError(result.error, t("errors.actionFailed"), {
                      description: userErrorFromThrown(
                        result.error,
                        t("common.unexpectedError"),
                      ),
                    });
                  }
                  return result;
                });
                detached(request, "contacts-page.fetch-next-page");
              }}
              variant="outline"
            >
              {t("common.loadMore")}
            </Button>
          )}
        </>
      )}
    </ContactsShell>
  );
}

type ContactItem = {
  id: string;
  type: ContactType;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  emails: { type: string; address: string; isPrimary: boolean }[] | null;
  phones: { type: string; number: string; isPrimary: boolean }[] | null;
  tags: string[] | null;
  color: string | null;
  createdAt: string;
  clientMatterCount: number;
};

const contactTableFeatures = tableFeatures({
  coreRowModel: createCoreRowModel(),
});
type ContactTableFeatures = typeof contactTableFeatures;

const columnHelper = createColumnHelper<ContactTableFeatures, ContactItem>();

type ContactCellProps = {
  columnId: ContactColumnId;
  contact: ContactItem;
  selectedIds: readonly string[];
  setSelectedIds: (ids: readonly string[]) => void;
};

// One cell per column id of the pending module's column list: a column added
// there fails this switch until it has a cell.
const ContactCell = ({
  columnId,
  contact,
  selectedIds,
  setSelectedIds,
}: ContactCellProps) => {
  const t = useTranslations();
  switch (columnId) {
    case "select":
      return (
        <Checkbox
          aria-label={t("contacts.selectContact", {
            name: contact.displayName,
          })}
          checked={selectedIds.includes(contact.id)}
          onCheckedChange={(checked) =>
            setSelectedIds(
              checked
                ? [...selectedIds, contact.id]
                : selectedIds.filter((id) => id !== contact.id),
            )
          }
        />
      );
    case "icon":
      return contact.type === "person" ? (
        <UserIcon className="text-muted-foreground size-4" />
      ) : (
        <BuildingIcon className="text-muted-foreground size-4" />
      );
    case "name":
      return (
        <ContactNameLink
          contactId={contact.id}
          displayName={contact.displayName}
        />
      );
    case "email": {
      const primaryEmail =
        contact.emails?.find((e) => e.isPrimary) ?? contact.emails?.at(0);
      if (!primaryEmail) {
        return null;
      }
      return (
        <a
          className="text-muted-foreground hover:text-foreground inline-block max-w-xs align-middle hover:underline"
          href={`mailto:${primaryEmail.address}`}
          onClick={(event) => event.stopPropagation()}
        >
          <TruncatedText>{primaryEmail.address}</TruncatedText>
        </a>
      );
    }
    case "phone": {
      const primaryPhone =
        contact.phones?.find((p) => p.isPrimary) ?? contact.phones?.at(0);
      return (
        <span className="text-muted-foreground">{primaryPhone?.number}</span>
      );
    }
    case "matters":
      return <MatterCount count={contact.clientMatterCount} />;
    case "actions":
      return <ContactRowActions contact={contact} />;
    default:
      columnId satisfies never;
      return panic("Unhandled contact column");
  }
};

const MatterCount = ({ count }: { count: number }) => {
  const formatter = useFormatter();
  return <div className="text-end tabular-nums">{formatter.number(count)}</div>;
};

// The TanStack columns follow the pending module's column list, so the loaded
// table, its loading rows and the route's pending view share one column order.
const contactColumnDefs = ({
  columns,
  selectedIds,
  setSelectedIds,
}: {
  columns: readonly ContactColumn[];
  selectedIds: readonly string[];
  setSelectedIds: (ids: readonly string[]) => void;
}) =>
  columns.map((column) =>
    columnHelper.display({
      id: column.id,
      cell: ({ row }) => (
        <ContactCell
          columnId={column.id}
          contact={row.original}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
        />
      ),
    }),
  );

const ContactTableRow = ({
  row,
}: {
  row: Row<ContactTableFeatures, ContactItem>;
}) => {
  const navigate = useNavigate();

  const openContact = () => {
    detached(
      navigate({
        to: "/contacts/$contactId",
        params: { contactId: row.original.id },
      }),
      "contacts.navigate",
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
      {row.getAllCells().map((cell) => {
        const stopsRowClick =
          cell.column.id === "select" || cell.column.id === "actions";
        return (
          <TableCell
            key={cell.id}
            onClick={
              stopsRowClick ? (event) => event.stopPropagation() : undefined
            }
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      })}
    </TableRow>
  );
};

const ContactRowActions = ({ contact }: { contact: ContactItem }) => {
  const t = useTranslations();
  const canDeleteContact = usePermissions({ contact: ["delete"] });
  const deleteContact = useDeleteContact();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteBlockedDescription = t("contacts.deleteContactBlockedByMatters");

  const handleDelete = async () => {
    await deleteContact.mutateAsync(
      { contactId: contact.id },
      {
        onSuccess: () => {
          detached(
            queryClient.invalidateQueries({
              queryKey: contactsKeys.all,
            }),
            "contacts.invalidate",
          );
          stellaToast.add({
            title: t("success.contactDeleted"),
            type: "success",
          });
        },
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  const handleDeleteOpen = () => {
    if (contact.clientMatterCount > 0) {
      notifyUserProblem(deleteBlockedDescription);
      return;
    }

    setDeleteOpen(true);
  };

  return (
    <div className="flex justify-end">
      <Menu>
        <Tooltip
          content={t("common.actions")}
          render={
            <MenuTrigger
              className="opacity-0! transition-opacity group-hover:opacity-100! pointer-coarse:opacity-100!"
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
              onClick={handleDeleteOpen}
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
    </div>
  );
};

type ContactsTableProps = {
  columns: readonly ContactColumn[];
  table: ReactTable<ContactTableFeatures, ContactItem>;
  state: QueryView<unknown, unknown>["type"];
  notice?: ReactNode;
};

// The loaded table inside the pending module's frame: the header and the
// loading rows come off the same column list as the route's pending view.
function ContactsTable({ columns, table, state, notice }: ContactsTableProps) {
  const t = useTranslations();
  const rows = table.getRowModel().rows;

  return (
    <ContactsTableFrame columns={columns}>
      {notice !== undefined && (
        <TableRow>
          <TableCell colSpan={columns.length}>{notice}</TableCell>
        </TableRow>
      )}
      {state === "pending" ? (
        <ContactsSkeletonRows columns={columns} />
      ) : (
        rows.map((row) => <ContactTableRow key={row.id} row={row} />)
      )}
      {state === "empty" && (
        <TableRow>
          <TableCell
            className="text-muted-foreground py-8 text-center"
            colSpan={columns.length}
          >
            <p>{t("contacts.noContactsFound")}</p>
            <p className="text-sm">{t("contacts.noContactsDescription")}</p>
          </TableCell>
        </TableRow>
      )}
    </ContactsTableFrame>
  );
}

const trimmedString = (maxLength: number) =>
  v.pipe(v.string(), v.trim(), v.maxLength(maxLength));

const requiredTrimmedString = (maxLength: number, message: string) =>
  v.pipe(v.string(), v.trim(), v.nonEmpty(message), v.maxLength(maxLength));

const createContactSchema = (requiredMessage: string) =>
  v.pipe(
    v.strictObject({
      type: v.picklist(CONTACT_TYPES),
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

type BusinessRegistryAddress = {
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  textAddress: string | null;
};

const CREATE_CONTACT_DEFAULT_VALUES: v.InferInput<
  ReturnType<typeof createContactSchema>
> = {
  type: "person",
  displayName: "",
  firstName: "",
  lastName: "",
  organizationName: "",
  registrationNumber: "",
};

const normalizeIcoInput = (value: string) => value.replaceAll(/\D/gu, "");

const toBillingAddress = (
  address: BusinessRegistryAddress | null,
): BillingAddress | null => {
  if (!address) {
    return null;
  }

  const line1 = address.line1 ?? address.textAddress ?? undefined;

  return {
    ...(line1 && { line1 }),
    ...(address.city && { city: address.city }),
    ...(address.region && { state: address.region }),
    ...(address.postalCode && { postalCode: address.postalCode }),
    ...(address.country && { country: address.country }),
  };
};

type CreateContactDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const CreateContactDialog = ({
  open,
  onOpenChange,
}: CreateContactDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [isAresLoading, setIsAresLoading] = useState(false);
  const [birthDate, setBirthDate] = useState<BirthDateDraft>(() =>
    birthDateDraft(null),
  );
  const [nationalityCodes, setNationalityCodes] = useState<string[]>([]);
  const [aresBillingAddress, setAresBillingAddress] =
    useState<BillingAddress | null>(null);
  const createContact = useCreateContact();
  const submitOnce = useSingleFlight();
  const extraction = useProcuracaoExtraction();
  const schema = createContactSchema(t("common.required"));
  const mcpCatalogQuery = useQuery(mcpConnectorsOptions(activeOrganizationId));
  const mcpCatalogView = queryView(mcpCatalogQuery);
  useQueryViewError(mcpCatalogView, "CreateContactDialog:query");
  const mcpCatalog =
    mcpCatalogView.type === "items" && mcpCatalogView.refetchError === undefined
      ? mcpCatalogView.items
      : undefined;
  const isAresEnabled =
    mcpCatalog?.nativeTools.find((tool) => tool.slug === ARES_NATIVE_TOOL_SLUG)
      ?.enabled ?? false;

  const form = useForm(
    schemaFormOptions({
      schema,
      defaultValues: CREATE_CONTACT_DEFAULT_VALUES,
      submitValues: "schema-output",
      onSubmit: async ({ value, formApi }) => {
        const dateOfBirth =
          value.type === "person" ? parseBirthDateDraft(birthDate) : null;
        if (
          value.type === "person" &&
          (birthDate.year || birthDate.month || birthDate.day) &&
          !dateOfBirth
        ) {
          notifyUserProblem(t("contacts.invalidDateOfBirth"));
          return;
        }
        const firstName =
          value.type === "person" ? value.firstName || undefined : undefined;
        const lastName =
          value.type === "person" ? value.lastName || undefined : undefined;
        const organizationName =
          value.type === "organization"
            ? value.organizationName || undefined
            : undefined;
        const registrationNumber =
          value.type === "organization"
            ? value.registrationNumber || undefined
            : undefined;

        await createContact.mutateAsync({
          type: value.type,
          displayName: value.displayName,
          ...(firstName && { firstName }),
          ...(lastName && { lastName }),
          ...(organizationName && { organizationName }),
          ...(registrationNumber && { registrationNumber }),
          ...(value.type === "person" && dateOfBirth && { dateOfBirth }),
          ...(value.type === "person" &&
            nationalityCodes.length > 0 && {
              nationalityCodes,
            }),
          ...(value.type === "organization" &&
            aresBillingAddress && { billingAddress: aresBillingAddress }),
        });

        await queryClient.invalidateQueries({
          queryKey: contactsKeys.all,
        });
        stellaToast.add({
          title: t("success.contactCreated"),
          type: "success",
        });
        onOpenChange(false);
        formApi.reset();
        setBirthDate(birthDateDraft(null));
        setNationalityCodes([]);
        setAresBillingAddress(null);
        setIsAresLoading(false);
      },
    }),
  );

  const { formErrors, dirty } = useSelector(form.store, (s) => ({
    formErrors: toFormErrors(s.fieldMeta),
    dirty: !s.isDefaultValue,
  }));

  const contactType = useSelector(form.store, (s) => s.values.type);

  const handleAresLookup = async () => {
    const ico = normalizeIcoInput(form.state.values.registrationNumber);

    if (ico.length !== 8) {
      notifyUserProblem(t("contacts.create.invalidIco"));
      return;
    }

    setIsAresLoading(true);
    const lookup = await Result.tryPromise({
      try: async () =>
        unwrapApiResponse(
          await api.contacts["business-registries"].get({
            query: { registry: "ares", q: ico },
          }),
        ),
      catch: (cause) => cause,
    });
    setIsAresLoading(false);
    if (lookup.isErr()) {
      getAnalytics().captureError(lookup.error, {
        fingerprintKey: "CreateContactDialog.handleAresLookup:failure",
        scope: {
          type: "handler",
          handlerId: "CreateContactDialog.handleAresLookup:failure",
        },
      });
      notifyUserError(lookup.error, t("errors.actionFailed"));
      return;
    }
    const data = lookup.value;

    const hit = data.type === "lookup" ? data.hit : null;

    if (!hit) {
      notifyUserProblem(t("contacts.create.aresNotFound"));
      return;
    }

    form.setFieldValue("registrationNumber", hit.id);
    form.setFieldValue("organizationName", hit.name);
    form.setFieldValue("displayName", hit.name);
    setAresBillingAddress(toBillingAddress(hit.address));

    stellaToast.add({
      title: t("contacts.create.aresApplied"),
      type: "success",
    });
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          form.reset();
          setBirthDate(birthDateDraft(null));
          setNationalityCodes([]);
          setAresBillingAddress(null);
          setIsAresLoading(false);
          extraction.reset();
        }
      }}
      open={open}
    >
      <DialogPopup
        className={cn(extraction.stage !== "idle" && "sm:max-w-2xl")}
      >
        <Form
          dirty={
            dirty ||
            birthDate.year !== "" ||
            birthDate.month !== "" ||
            birthDate.day !== "" ||
            nationalityCodes.length > 0 ||
            aresBillingAddress !== null ||
            extraction.review.isDirty
          }
          onDiscard={() => {
            form.reset();
            setBirthDate(birthDateDraft(null));
            setNationalityCodes([]);
            setAresBillingAddress(null);
            extraction.reset();
          }}
          className="gap-0"
          errors={formErrors}
          onSubmit={(e) => {
            e.preventDefault();
            detached(
              submitOnce.run(async () => await form.handleSubmit()),
              "contacts.submit",
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("contacts.newContact")}</DialogTitle>
            <DialogDescription>
              {extraction.review.results
                ? t("contacts.import.resultsSummary", {
                    created: extraction.review.results.filter(
                      (r) => r.status === "created",
                    ).length,
                    skipped: extraction.review.results.filter(
                      (r) => r.status === "skipped",
                    ).length,
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          {extraction.stage === "idle" ? (
            <DialogPanel className="flex flex-col gap-4">
              <ProcuracaoDropZone
                isExtracting={extraction.isExtracting}
                onFile={(file) =>
                  detached(
                    extraction.extractFile(file),
                    "contact-extract-procuracao.upload",
                  )
                }
              />
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
                        <FieldLabel>
                          {t("contacts.fields.firstName")}
                        </FieldLabel>
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

                  {isAresEnabled ? (
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
                                dir="ltr"
                                inputMode="numeric"
                                onBlur={field.handleBlur}
                                onChange={(e) => {
                                  field.handleChange(
                                    normalizeIcoInput(e.target.value),
                                  );
                                  setAresBillingAddress(null);
                                }}
                                placeholder={t(
                                  "contacts.create.icoPlaceholder",
                                )}
                                value={field.state.value}
                              />
                              <Button
                                loading={isAresLoading}
                                onClick={() => {
                                  detached(
                                    handleAresLookup(),
                                    "contacts.ares-lookup",
                                  );
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
                  ) : (
                    <form.Field name="registrationNumber">
                      {(field) => (
                        <Field name={field.name}>
                          <FieldLabel>
                            {t("contacts.fields.registrationNumber")}
                          </FieldLabel>
                          <Input
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                            value={field.state.value}
                          />
                          <FieldError />
                        </Field>
                      )}
                    </form.Field>
                  )}
                </>
              )}

              <form.Field name="displayName">
                {(field) => (
                  <Field name={field.name}>
                    <FieldLabel>{t("common.displayName")}</FieldLabel>
                    <Input
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      value={field.state.value}
                    />
                    <p className="text-muted-foreground text-xs">
                      {t(
                        contactType === "person"
                          ? "contacts.create.displayNamePersonHint"
                          : "contacts.create.displayNameOrganizationHint",
                      )}
                    </p>
                    <FieldError />
                  </Field>
                )}
              </form.Field>
              {contactType === "person" && (
                <PersonDetailsFields
                  birthDate={birthDate}
                  nationalityCodes={nationalityCodes}
                  onBirthDateChange={setBirthDate}
                  onNationalityCodesChange={setNationalityCodes}
                />
              )}
            </DialogPanel>
          ) : (
            <DialogPanel className="flex max-h-[60dvh] flex-col gap-4 overflow-y-auto">
              <ProcuracaoReview extraction={extraction} />
            </DialogPanel>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t(
                extraction.stage === "done" ? "common.close" : "common.cancel",
              )}
            </DialogClose>
            {extraction.stage === "idle" && (
              <form.Subscribe selector={(s) => s.isSubmitting}>
                {(isSubmitting) => (
                  <Button loading={isSubmitting} type="submit">
                    {t("common.save")}
                  </Button>
                )}
              </form.Subscribe>
            )}
            {extraction.stage === "review" && (
              <Button
                disabled={!extraction.canConfirm}
                loading={extraction.isConfirming}
                onClick={() =>
                  detached(
                    extraction.confirm(),
                    "contact-extract-procuracao.confirm",
                  )
                }
                type="button"
              >
                {t("contacts.import.confirmAction")}
              </Button>
            )}
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};
