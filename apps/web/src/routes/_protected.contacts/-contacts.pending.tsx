import type { ComponentProps, ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ContactType } from "@stll/api-contract";
import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import { Button } from "@stll/ui/button";
import { DownloadIcon, PlusIcon, UploadIcon } from "@stll/ui/icons";
import { SearchField } from "@stll/ui/search-field";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "@/components/responsive-action-toolbar";
import { cachedRoleGrants } from "@/lib/cached-permissions.logic";

export type ContactFilter = "all" | ContactType;

export type ContactColumnId =
  "select" | "icon" | "name" | "email" | "phone" | "matters" | "actions";

/** How a column's cell looks while its rows load. */
type ContactSkeletonShape = "box" | "count" | "bar" | "none";

/**
 * One column of the contacts table, as data: its id, its heading and how its
 * placeholder looks. The page builds its cells off the same list, so the
 * loaded table, its loading rows and this pending view cannot drift.
 */
export type ContactColumn = {
  id: ContactColumnId;
  label:
    | "common.name"
    | "common.email"
    | "contacts.columns.phone"
    | "common.matters"
    | null;
  align?: "end";
  skeleton: ContactSkeletonShape;
};

const CONTACT_COLUMNS: readonly ContactColumn[] = [
  { id: "select", label: null, skeleton: "box" },
  { id: "icon", label: null, skeleton: "box" },
  { id: "name", label: "common.name", skeleton: "bar" },
  { id: "email", label: "common.email", skeleton: "bar" },
  { id: "phone", label: "contacts.columns.phone", skeleton: "bar" },
  { id: "matters", label: "common.matters", align: "end", skeleton: "count" },
  { id: "actions", label: null, skeleton: "none" },
];

const CONTACT_COLUMNS_WITHOUT_SELECT = CONTACT_COLUMNS.filter(
  (column) => column.id !== "select",
);

/** Selection only feeds bulk delete, so it shows only to who may delete. */
export const contactColumns = (canSelect: boolean): readonly ContactColumn[] =>
  canSelect ? CONTACT_COLUMNS : CONTACT_COLUMNS_WITHOUT_SELECT;

/** Rows held open while the contacts load. */
const SKELETON_ROW_COUNT = 8;

/** The contacts page's frame: a scrolling column of toolbar and table. */
export const ContactsShell = ({ children }: { children: ReactNode }) => (
  <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
    {children}
  </div>
);

/** The toolbar's three slots: search, the type filters and the actions. */
export const ContactsToolbar = ({
  search,
  filters,
  actions,
}: {
  search: ReactNode;
  filters: ReactNode;
  actions: ReactNode;
}) => (
  <ResponsiveActionToolbar>
    <ResponsiveActionToolbarItem slot="primary">
      {search}
    </ResponsiveActionToolbarItem>
    <ResponsiveActionToolbarItem slot="secondary">
      <div className="flex flex-wrap gap-1">{filters}</div>
    </ResponsiveActionToolbarItem>
    <ResponsiveActionToolbarItem slot="action">
      <div className="flex gap-1">{actions}</div>
    </ResponsiveActionToolbarItem>
  </ResponsiveActionToolbar>
);

const noop = () => undefined;

/** The contacts search; inert until the page hands it a handler. */
export const ContactsSearchField = ({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange?: (value: string) => void;
}) => {
  const t = useTranslations();
  return (
    <SearchField
      aria-label={t("contacts.search")}
      clearLabel={t("common.clearSearch")}
      disabled={onValueChange === undefined}
      groupClassName="sm:max-w-sm"
      maxLength={SEARCH_QUERY_MAX_LENGTH}
      onValueChange={onValueChange ?? noop}
      placeholder={t("contacts.search")}
      value={value}
    />
  );
};

const FilterButton = ({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: (() => void) | undefined;
}) => (
  <Button
    aria-pressed={active}
    disabled={onClick === undefined}
    onClick={onClick}
    size="sm"
    variant={active ? "default" : "outline"}
  >
    {label}
  </Button>
);

/** The type filters; inert until the page hands them a handler. */
export const ContactFilterButtons = ({
  filter,
  onFilterChange,
}: {
  filter: ContactFilter;
  onFilterChange?: (filter: ContactFilter) => void;
}) => {
  const t = useTranslations();
  const select = (next: ContactFilter) =>
    onFilterChange === undefined ? undefined : () => onFilterChange(next);
  return (
    <>
      <FilterButton
        active={filter === "all"}
        label={t("common.all")}
        onClick={select("all")}
      />
      <FilterButton
        active={filter === "person"}
        label={t("contacts.filterPersons")}
        onClick={select("person")}
      />
      <FilterButton
        active={filter === "organization"}
        label={t("common.organizations")}
        onClick={select("organization")}
      />
    </>
  );
};

/** A toolbar action: its icon, with the label beside it from `sm` up. */
export const ContactsToolbarButton = ({
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
  <Button {...props} aria-label={label} size="sm" title={label}>
    {icon}
    <span className="hidden sm:inline">{label}</span>
  </Button>
);

const ContactColumnLabel = ({ column }: { column: ContactColumn }) => {
  const t = useTranslations();
  if (column.label === null) {
    return null;
  }
  const label = t(column.label);
  return column.align === "end" ? (
    <div className="text-end">{label}</div>
  ) : (
    label
  );
};

/** The table with its header row; the body is the caller's. */
export const ContactsTableFrame = ({
  columns,
  children,
}: {
  columns: readonly ContactColumn[];
  children: ReactNode;
}) => (
  <Table>
    <TableHeader>
      <TableRow>
        {columns.map((column) => (
          <TableHead key={column.id}>
            <ContactColumnLabel column={column} />
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
    <TableBody>{children}</TableBody>
  </Table>
);

const ContactSkeletonCell = ({ shape }: { shape: ContactSkeletonShape }) => {
  switch (shape) {
    case "box":
      return <Skeleton className="size-4 rounded-sm" />;
    case "count":
      return <Skeleton className="ms-auto h-4 w-6" />;
    case "bar":
      return <Skeleton className="h-4 w-3/5" />;
    case "none":
      return null;
    default:
      shape satisfies never;
      return panic("Unhandled contact skeleton shape");
  }
};

/** Loading rows, one placeholder cell per column, in the columns' order. */
export const ContactsSkeletonRows = ({
  columns,
}: {
  columns: readonly ContactColumn[];
}) =>
  Array.from({ length: SKELETON_ROW_COUNT }, (_, row) => (
    <TableRow key={row}>
      {columns.map((column) => (
        <TableCell key={column.id}>
          <ContactSkeletonCell shape={column.skeleton} />
        </TableCell>
      ))}
    </TableRow>
  ));

/**
 * The contacts page while its first page of contacts loads: the chrome the
 * cached role gets (selection for those who may delete, import and new
 * contact for those who may create), all inert until the page is there.
 */
export const ContactsPending = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const canCreateContact = cachedRoleGrants(queryClient, {
    contact: ["create"],
  });
  const columns = contactColumns(
    cachedRoleGrants(queryClient, { contact: ["delete"] }),
  );
  return (
    <ContactsShell>
      <ContactsToolbar
        actions={
          <>
            {canCreateContact && (
              <ContactsToolbarButton
                disabled
                icon={<UploadIcon />}
                label={t("common.import")}
                variant="outline"
              />
            )}
            <ContactsToolbarButton
              disabled
              icon={<DownloadIcon />}
              label={t("workspaces.views.exportCsv")}
              variant="outline"
            />
            {canCreateContact && (
              <ContactsToolbarButton
                disabled
                icon={<PlusIcon />}
                label={t("contacts.newContact")}
              />
            )}
          </>
        }
        filters={<ContactFilterButtons filter="all" />}
        search={<ContactsSearchField value="" />}
      />
      <ContactsTableFrame columns={columns}>
        <ContactsSkeletonRows columns={columns} />
      </ContactsTableFrame>
    </ContactsShell>
  );
};
