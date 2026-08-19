import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { useForm } from "@tanstack/react-form";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createFileRoute,
  getRouteApi,
  Link,
  useNavigate,
} from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import {
  createColumnHelper,
  createCoreRowModel,
  flexRender,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { Column, ReactTable, Row } from "@tanstack/react-table";
import { Result } from "better-result";
import {
  BuildingIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  PlusIcon,
  SearchIcon,
  UploadIcon,
  UserIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { CONTACT_TYPES, type ContactType } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
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
import { Input } from "@stll/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { EmptyScreen } from "@/components/empty-screen";
import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "@/components/responsive-action-toolbar";
import { TableSkeletonRows } from "@/components/table-skeleton-rows";
import Tooltip from "@/components/tooltip";
import { usePermissions } from "@/hooks/use-permissions";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useCreateContact, useDeleteContact } from "@/lib/contacts/mutations";
import { contactsKeys, contactsOptions } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { toFormErrors } from "@/lib/schema";
import { downloadFile } from "@/lib/utils";
import {
  ProcuracaoDropZone,
  ProcuracaoReview,
  useProcuracaoExtraction,
} from "@/routes/_protected.contacts/-procuracao-extraction";

const ARES_NATIVE_TOOL_SLUG = "ares";

type ContactFilter = "all" | ContactType;

export const Route = createFileRoute("/_protected/contacts/")({
  loader: async ({ context }) => {
    await ensureRouteInfiniteQueryData(
      context.queryClient,
      contactsOptions(context.user.activeOrganizationId),
    );
  },
  head: () => ({
    meta: [{ title: pageTitle("navigation.contacts") }],
  }),
  component: ContactsPage,
  pendingComponent: ContactsPendingComponent,
});

const protectedRouteApi = getRouteApi("/_protected");

function ContactsPage() {
  const t = useTranslations();
  const tContacts = useTranslations("contacts");
  const canCreateContact = usePermissions({ contact: ["create"] });
  const [createContactOpen, setCreateContactOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [filter, setFilter] = useState<ContactFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const updateSearch = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value);
  }, 300);

  const typeFilter = filter === "all" ? undefined : filter;
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery(
      contactsOptions(activeOrganizationId, {
        type: typeFilter,
        q: debouncedQuery || undefined,
      }),
    );

  const items: ContactItem[] = data
    ? data.pages.flatMap((page) => page.items)
    : [];
  const isFirstUseEmpty =
    !isLoading &&
    items.length === 0 &&
    searchQuery.trim() === "" &&
    filter === "all";

  const columns = useContactColumns();

  const table = useTable({
    features: contactTableFeatures,
    data: items,
    columns,
    getRowId: (row) => row.id,
  });

  const handleExport = async () => {
    setIsExporting(true);
    const result = await Result.tryPromise(async () => {
      const response = await api.contacts.export.get({
        query: { format: "csv" },
      });
      const exportData = unwrapEden(response);
      return exportData instanceof Response
        ? await exportData.blob()
        : new Blob([String(exportData)], { type: "text/csv;charset=utf-8" });
    });
    setIsExporting(false);

    if (Result.isError(result)) {
      stellaToast.add({
        title: userErrorFromThrown(result.error, t("contacts.exportFailed")),
        type: "error",
      });
      return;
    }

    downloadFile(result.value, "contacts-export.csv");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t p-4">
      <ResponsiveActionToolbar>
        <ResponsiveActionToolbarItem slot="primary">
          <InputGroup className="min-h-11 sm:min-h-0 sm:max-w-sm">
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
        </ResponsiveActionToolbarItem>
        <ResponsiveActionToolbarItem slot="secondary">
          <div className="flex gap-1 overflow-x-auto">
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
        </ResponsiveActionToolbarItem>
        <ResponsiveActionToolbarItem className="ms-auto sm:ms-0" slot="action">
          <div className="flex gap-1">
            {canCreateContact && (
              <Button
                aria-label={t("common.import")}
                render={<Link to="/contacts/import" />}
                size="sm"
                title={t("common.import")}
                variant="outline"
              >
                <UploadIcon />
                <span className="hidden sm:inline">{t("common.import")}</span>
              </Button>
            )}
            <Button
              aria-busy={isExporting}
              aria-label={t("workspaces.views.exportCsv")}
              disabled={isExporting}
              onClick={() => {
                detached(handleExport(), "contacts-page.export");
              }}
              size="sm"
              title={t("workspaces.views.exportCsv")}
              variant="outline"
            >
              <DownloadIcon />
              <span className="hidden sm:inline">
                {t("workspaces.views.exportCsv")}
              </span>
            </Button>
            {canCreateContact && (
              <>
                <Button
                  aria-label={t("contacts.newContact")}
                  onClick={() => setCreateContactOpen(true)}
                  size="sm"
                  title={t("contacts.newContact")}
                >
                  <PlusIcon />
                  <span className="hidden sm:inline">
                    {t("contacts.newContact")}
                  </span>
                </Button>
                <CreateContactDialog
                  onOpenChange={setCreateContactOpen}
                  open={createContactOpen}
                />
              </>
            )}
          </div>
        </ResponsiveActionToolbarItem>
      </ResponsiveActionToolbar>

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
          <ContactsTable isLoading={isLoading} table={table} />
          {hasNextPage && (
            <Button
              className="self-center"
              loading={isFetchingNextPage}
              onClick={() => {
                const request = fetchNextPage().then((result) => {
                  if (result.isError) {
                    stellaToast.add({
                      description: userErrorFromThrown(
                        result.error,
                        t("common.unexpectedError"),
                      ),
                      title: t("errors.actionFailed"),
                      type: "error",
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
    </div>
  );
}

type FilterButtonProps = {
  label: string;
  active: boolean;
  onClick: () => void;
};

const FilterButton = ({ label, active, onClick }: FilterButtonProps) => (
  <Button
    aria-pressed={active}
    onClick={onClick}
    size="sm"
    variant={active ? "default" : "outline"}
  >
    {label}
  </Button>
);

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
  createdAt: Date;
  clientMatterCount: number;
};

const contactTableFeatures = tableFeatures({
  coreRowModel: createCoreRowModel(),
});
type ContactTableFeatures = typeof contactTableFeatures;

const columnHelper = createColumnHelper<ContactTableFeatures, ContactItem>();

// Single column source of truth: the page table, its loading skeleton, and the
// route-level pending shell all derive from this, so none can drift.
const useContactColumns = () => {
  const t = useTranslations();
  return useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "icon",
          header: () => null,
          cell: ({ row }) =>
            row.original.type === "person" ? (
              <UserIcon className="text-muted-foreground size-4" />
            ) : (
              <BuildingIcon className="text-muted-foreground size-4" />
            ),
        }),
        columnHelper.accessor("displayName", {
          id: "name",
          header: t("common.name"),
          cell: ({ row, getValue }) => (
            <Link
              className="font-medium hover:underline"
              dir="auto"
              onClick={(event) => event.stopPropagation()}
              params={{ contactId: row.original.id }}
              to="/contacts/$contactId"
            >
              {getValue()}
            </Link>
          ),
        }),
        columnHelper.display({
          id: "email",
          header: t("common.email"),
          cell: ({ row }) => {
            const primaryEmail =
              row.original.emails?.find((e) => e.isPrimary) ??
              row.original.emails?.at(0);
            if (!primaryEmail) {
              return null;
            }
            return (
              <a
                className="text-muted-foreground hover:text-foreground hover:underline"
                href={`mailto:${primaryEmail.address}`}
              >
                {primaryEmail.address}
              </a>
            );
          },
        }),
        columnHelper.display({
          id: "phone",
          header: t("contacts.columns.phone"),
          cell: ({ row }) => {
            const primaryPhone =
              row.original.phones?.find((p) => p.isPrimary) ??
              row.original.phones?.at(0);
            return (
              <span className="text-muted-foreground">
                {primaryPhone?.number}
              </span>
            );
          },
        }),
        columnHelper.accessor("clientMatterCount", {
          id: "matters",
          header: () => <div className="text-end">{t("common.matters")}</div>,
          cell: ({ getValue }) => (
            <div className="text-end tabular-nums">{getValue()}</div>
          ),
        }),
        columnHelper.display({
          id: "actions",
          header: () => null,
          cell: ({ row }) => <ContactRowActions contact={row.original} />,
        }),
      ]),
    [t],
  );
};

// Placeholder cells keyed off each column's stable id, so the loading state
// stays aligned with the column definitions above without a parallel skeleton.
const renderContactSkeletonCell = (
  column: Column<ContactTableFeatures, ContactItem>,
): ReactNode => {
  if (column.id === "icon") {
    return <Skeleton className="size-4 rounded" />;
  }
  if (column.id === "matters") {
    return <Skeleton className="ms-auto h-4 w-6" />;
  }
  if (column.id === "actions") {
    return null;
  }
  return undefined;
};

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
          cell.column.id === "email" || cell.column.id === "actions";
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
          stellaToast.add({
            title: userErrorFromThrown(error, t("errors.actionFailed")),
            type: "error",
          });
        },
      },
    );
  };

  const handleDeleteOpen = () => {
    if (contact.clientMatterCount > 0) {
      stellaToast.add({
        title: deleteBlockedDescription,
        type: "error",
      });
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

const EMPTY_CONTACTS: ContactItem[] = [];

type ContactsTableProps = {
  table: ReactTable<ContactTableFeatures, ContactItem>;
  isLoading: boolean;
};

// Shared table render for both the live page and the route pending shell:
// header, rows, and skeleton all come off the same TanStack column model.
const ContactsTable = ({ table, isLoading }: ContactsTableProps) => {
  const t = useTranslations();
  const rows = table.getRowModel().rows;

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id}>
                {flexRender(
                  header.column.columnDef.header,
                  header.getContext(),
                )}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <TableSkeletonRows
            columns={table.getAllLeafColumns()}
            renderCell={renderContactSkeletonCell}
          />
        ) : (
          rows.map((row) => <ContactTableRow key={row.id} row={row} />)
        )}
        {!isLoading && rows.length === 0 && (
          <TableRow>
            <TableCell
              className="text-muted-foreground py-8 text-center"
              colSpan={table.getAllLeafColumns().length}
            >
              <p>{t("contacts.noContactsFound")}</p>
              <p className="text-sm">{t("contacts.noContactsDescription")}</p>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
};

// Inert toolbar matching the live layout, so the pending shell reserves the
// same space and the page does not jump when it swaps in.
const ContactsToolbarPlaceholder = () => {
  const t = useTranslations();
  const canCreateContact = usePermissions({ contact: ["create"] });

  return (
    <ResponsiveActionToolbar>
      <ResponsiveActionToolbarItem slot="primary">
        <InputGroup className="min-h-11 sm:min-h-0 sm:max-w-sm">
          <InputGroupInput disabled placeholder={t("contacts.search")} />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
      </ResponsiveActionToolbarItem>
      <ResponsiveActionToolbarItem slot="secondary">
        <div className="flex gap-1 overflow-x-auto">
          <Button disabled size="sm" variant="default">
            {t("common.all")}
          </Button>
          <Button disabled size="sm" variant="outline">
            {t("contacts.filterPersons")}
          </Button>
          <Button disabled size="sm" variant="outline">
            {t("contacts.filterOrganizations")}
          </Button>
        </div>
      </ResponsiveActionToolbarItem>
      <ResponsiveActionToolbarItem className="ms-auto sm:ms-0" slot="action">
        <div className="flex gap-1">
          {canCreateContact && (
            <Button
              aria-label={t("common.import")}
              disabled
              size="sm"
              title={t("common.import")}
              variant="outline"
            >
              <UploadIcon />
              <span className="hidden sm:inline">{t("common.import")}</span>
            </Button>
          )}
          <Button
            aria-label={t("workspaces.views.exportCsv")}
            disabled
            size="sm"
            title={t("workspaces.views.exportCsv")}
            variant="outline"
          >
            <DownloadIcon />
            <span className="hidden sm:inline">
              {t("workspaces.views.exportCsv")}
            </span>
          </Button>
          {canCreateContact && (
            <Button disabled size="sm">
              <PlusIcon />
              <span className="hidden sm:inline">
                {t("contacts.newContact")}
              </span>
            </Button>
          )}
        </div>
      </ResponsiveActionToolbarItem>
    </ResponsiveActionToolbar>
  );
};

function ContactsPendingComponent() {
  const columns = useContactColumns();
  const table = useTable({
    features: contactTableFeatures,
    data: EMPTY_CONTACTS,
    columns,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t p-4">
      <ContactsToolbarPlaceholder />
      <ContactsTable isLoading table={table} />
    </div>
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
  const [aresBillingAddress, setAresBillingAddress] =
    useState<BillingAddress | null>(null);
  const createContact = useCreateContact();
  const extraction = useProcuracaoExtraction();
  const schema = createContactSchema(t("common.required"));
  const { data: mcpCatalog } = useQuery(
    mcpConnectorsOptions(activeOrganizationId),
  );
  const isAresEnabled =
    mcpCatalog?.nativeTools.find((tool) => tool.slug === ARES_NATIVE_TOOL_SLUG)
      ?.enabled ?? false;

  const form = useForm({
    defaultValues: CREATE_CONTACT_DEFAULT_VALUES,
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
      stellaToast.add({
        title: t("success.contactCreated"),
        type: "success",
      });
      onOpenChange(false);
      form.reset();
      setAresBillingAddress(null);
      setIsAresLoading(false);
    },
  });

  const formErrors = useSelector(form.store, (s) => toFormErrors(s.fieldMeta));

  const contactType = useSelector(form.store, (s) => s.values.type);

  const handleAresLookup = async () => {
    const ico = normalizeIcoInput(form.state.values.registrationNumber);

    if (ico.length !== 8) {
      stellaToast.add({
        title: t("contacts.create.invalidIco"),
        type: "error",
      });
      return;
    }

    setIsAresLoading(true);
    try {
      const response = await api.contacts["business-registries"].get({
        query: { registry: "ares", q: ico },
      });
      const data = unwrapEden(response);

      const hit = data.type === "lookup" ? data.hit : null;

      if (!hit) {
        stellaToast.add({
          title: t("contacts.create.aresNotFound"),
          type: "error",
        });
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
    } catch (error) {
      getAnalytics().captureError(error);
      stellaToast.add({
        title: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    } finally {
      setIsAresLoading(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          form.reset();
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
          className="gap-0"
          errors={formErrors}
          onSubmit={(e) => {
            e.preventDefault();
            detached(form.handleSubmit(), "contacts.submit");
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
          ) : (
            <DialogPanel className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
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
