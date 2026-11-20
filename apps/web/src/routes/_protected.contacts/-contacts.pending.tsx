import type { ReactNode } from "react";

import type { ContactType } from "@stll/api-contract";
import { ButtonFace, InputFace } from "@stll/ui/control-face";
import { DownloadIcon, PlusIcon, UploadIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCellFace,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table-shell";
import { cn } from "@stll/ui/utils";
import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "@stll/workspace-ui/responsive-action-toolbar";

import { usePendingCache } from "@/components/pending-cache";
import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { framePendingView } from "@/routes/-pending-view.logic";

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

/** The search field's width in the toolbar, as the page's field sets it. */
const CONTACTS_SEARCH_CLASS = "sm:max-w-sm";

/** The type filters, in their order, with the words each one reads. */
export const CONTACT_FILTERS = [
  { filter: "all", labelKey: "common.all" },
  { filter: "person", labelKey: "contacts.filterPersons" },
  { filter: "organization", labelKey: "common.organizations" },
] as const satisfies readonly {
  filter: ContactFilter;
  labelKey: PendingTextKey;
}[];

/** A type filter's button: raised while it is the chosen filter. */
export const contactFilterButton = (active: boolean) =>
  ({ size: "sm", variant: active ? "default" : "outline" }) as const;

/** A toolbar action's size, in both phases. */
export const CONTACTS_TOOLBAR_BUTTON_SIZE = "sm";

/** A toolbar action's content: its icon, with the label beside it from `sm`
 *  up. */
export const ContactsToolbarButtonContent = ({
  icon,
  label,
}: {
  icon: ReactNode;
  label: ReactNode;
}) => (
  <>
    {icon}
    <span className="hidden sm:inline">{label}</span>
  </>
);

const ContactColumnLabel = ({ column }: { column: ContactColumn }) => {
  if (column.label === null) {
    return null;
  }
  const label = <PendingText barClassName="w-14" id={column.label} />;
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

const CONTACT_SKELETON_CELLS = {
  box: <Skeleton className="size-4 rounded-sm" />,
  count: <Skeleton className="ms-auto h-4 w-6" />,
  bar: <Skeleton className="h-4 w-3/5" />,
  none: null,
} as const satisfies Record<ContactSkeletonShape, ReactNode>;

/** Loading rows, one placeholder cell per column, in the columns' order. */
export const ContactsSkeletonRows = ({
  columns,
}: {
  columns: readonly ContactColumn[];
}) =>
  Array.from({ length: SKELETON_ROW_COUNT }, (_, row) => (
    <TableRow aria-hidden="true" key={row}>
      {columns.map((column) => (
        <TableCellFace key={column.id}>
          {CONTACT_SKELETON_CELLS[column.skeleton]}
        </TableCellFace>
      ))}
    </TableRow>
  ));

const ContactsToolbarActionFace = ({
  icon,
  labelKey,
  variant,
}: {
  icon: ReactNode;
  labelKey: PendingTextKey;
  variant: "default" | "outline";
}) => (
  <ButtonFace size={CONTACTS_TOOLBAR_BUTTON_SIZE} variant={variant}>
    <ContactsToolbarButtonContent
      icon={icon}
      label={<PendingText barClassName="w-16" id={labelKey} />}
    />
  </ButtonFace>
);

/**
 * The toolbar before the page has loaded: the search field, the type filters
 * with "All" chosen and the actions the cached role gets, in their boxes and
 * order, unavailable.
 */
const ContactsToolbarFace = ({
  canCreateContact,
}: {
  canCreateContact: boolean;
}) => (
  <ContactsToolbar
    actions={
      <>
        {canCreateContact && (
          <ContactsToolbarActionFace
            icon={<UploadIcon />}
            labelKey="common.import"
            variant="outline"
          />
        )}
        <ContactsToolbarActionFace
          icon={<DownloadIcon />}
          labelKey="workspaces.views.exportCsv"
          variant="outline"
        />
        {canCreateContact && (
          <ContactsToolbarActionFace
            icon={<PlusIcon />}
            labelKey="contacts.newContact"
            variant="default"
          />
        )}
      </>
    }
    filters={CONTACT_FILTERS.map(({ filter, labelKey }) => {
      const button = contactFilterButton(filter === "all");
      return (
        <ButtonFace key={filter} size={button.size} variant={button.variant}>
          <PendingText barClassName="w-12" id={labelKey} />
        </ButtonFace>
      );
    })}
    search={
      <InputFace
        // The box `SearchField` draws: a touch-sized row on a phone.
        className={cn("min-h-11 sm:min-h-0", CONTACTS_SEARCH_CLASS)}
        fieldClassName="max-sm:h-11"
      >
        <PendingText barClassName="w-32" id="contacts.search" />
      </InputFace>
    }
  />
);

/**
 * The contacts page while its first page of contacts loads: the chrome the
 * cached role gets (selection for those who may delete, import and new
 * contact for those who may create), all inert until the page is there.
 */
const ContactsPendingView = () => {
  const cache = usePendingCache();
  const canCreateContact =
    cache !== null && cachedRoleGrants(cache, { contact: ["create"] });
  const columns = contactColumns(
    cache !== null && cachedRoleGrants(cache, { contact: ["delete"] }),
  );
  return (
    <ContactsShell>
      <ContactsToolbarFace canCreateContact={canCreateContact} />
      <ContactsTableFrame columns={columns}>
        <ContactsSkeletonRows columns={columns} />
      </ContactsTableFrame>
    </ContactsShell>
  );
};

export const ContactsPending = framePendingView(ContactsPendingView);
