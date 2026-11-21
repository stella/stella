import { Fragment } from "react";
import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending, InputFace } from "@stll/ui/control-face";
import { ChevronsUpDownIcon, ListChecksIcon, PlusIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
} from "@stll/ui/table-shell";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

type ListsShellProps = {
  busy?: boolean;
  children: ReactNode;
  createList: ReactNode;
  lists: ReactNode;
};

export const ListsShell = ({
  busy,
  children,
  createList,
  lists,
}: ListsShellProps) => (
  <main aria-busy={busy} className="bg-muted/30 flex h-full min-h-0">
    <aside className="bg-background flex w-64 shrink-0 flex-col border-e">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <ListChecksIcon className="size-4" />
        <h1 className="text-sm font-semibold">
          <PendingText barClassName="w-12" id="folio.listsGroup" />
        </h1>
      </header>
      <ScrollArea axis="vertical" className="flex-1">
        <div className="flex flex-col gap-1 p-2">{lists}</div>
      </ScrollArea>
      <div className="border-t p-2">{createList}</div>
    </aside>
    <section className="bg-background min-w-0 flex-1 overflow-hidden">
      {children}
    </section>
  </main>
);

type ListDetailShellProps = {
  busy?: boolean;
  children: ReactNode;
  createItem: ReactNode;
  heading: ReactNode;
  tools: ReactNode;
};

export const ListDetailShell = ({
  busy,
  children,
  createItem,
  heading,
  tools,
}: ListDetailShellProps) => (
  <div aria-busy={busy} className="flex h-full min-h-0 flex-col">
    <header className="flex items-start justify-between gap-4 border-b px-6 py-4">
      <div className="min-w-0">{heading}</div>
      {tools}
    </header>
    <div className="border-b px-6 py-3">{createItem}</div>
    {children}
  </div>
);

const LIST_ITEM_COLUMNS = [
  { id: "name", label: "common.name", width: "w-48", bar: "w-24" },
  {
    id: "description",
    label: "common.description",
    width: "w-64",
    bar: "w-32",
  },
  { id: "section", label: "common.category", width: "w-28", bar: "w-14" },
  { id: "status", label: "tasks.status", width: "w-28", bar: "w-14" },
  { id: "priority", label: "tasks.priority", width: "w-24", bar: "w-12" },
  { id: "dueDate", label: "tasks.dueDate", width: "w-32", bar: "w-20" },
] as const;
const ACTIONS_COLUMN = {
  id: "actions",
  align: "end",
  label: "common.actions",
  width: "w-24",
  bar: "w-14",
} as const;

type ListItemColumnId = (typeof LIST_ITEM_COLUMNS)[number]["id"];
type ListTableCells = Record<ListItemColumnId, ReactNode>;

export const ListTableRow = ({
  actions,
  cells,
  customCells,
}: {
  actions: ReactNode;
  cells: ListTableCells;
  customCells: ReactNode;
}) => (
  <TableRow>
    {LIST_ITEM_COLUMNS.map(({ id }) => (
      <Fragment key={id}>{cells[id]}</Fragment>
    ))}
    {customCells}
    {actions}
  </TableRow>
);

const NO_CUSTOM_COLUMNS = [] as const;

export const ListTable = ({
  busy,
  children,
  columns = NO_CUSTOM_COLUMNS,
}: {
  busy?: boolean;
  children: ReactNode;
  columns?: readonly { id: string; name: string }[];
}) => (
  <Table aria-busy={busy} inset="card" scroll="parent">
    <TableHeader sticky>
      <TableRow>
        {LIST_ITEM_COLUMNS.map(({ id, label, width, bar }) => (
          <TableHead className={width} key={id}>
            <PendingText barClassName={bar} id={label} />
          </TableHead>
        ))}
        {columns.map((column) => (
          <TableHead key={column.id}>{column.name}</TableHead>
        ))}
        <TableHead
          align={ACTIONS_COLUMN.align}
          className={ACTIONS_COLUMN.width}
        >
          <PendingText
            barClassName={ACTIONS_COLUMN.bar}
            id={ACTIONS_COLUMN.label}
          />
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>{children}</TableBody>
  </Table>
);

export const ListTableScroll = ({ children }: { children: ReactNode }) => (
  <ScrollArea className="flex-1">{children}</ScrollArea>
);

const SKELETON_ROWS = ["a", "b", "c", "d", "e"];

export const ListTableRowsPending = ({
  columns = NO_CUSTOM_COLUMNS,
}: {
  columns?: readonly { id: string }[];
}) => (
  <TableSkeletonRows
    columns={[
      ...LIST_ITEM_COLUMNS,
      ...columns.map(({ id }) => ({ id, bar: "w-20" })),
      ACTIONS_COLUMN,
    ]}
  />
);

const ListSidebarRowPending = () => (
  <ButtonFace className="w-full justify-start" size="default" variant="ghost">
    <FaceLabelPending className="w-28" />
  </ButtonFace>
);

const AddLabel = () => (
  <>
    <PlusIcon />
    <PendingText barClassName="w-8" id="common.add" />
  </>
);

const ListSelectFace = ({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) => (
  <ButtonFace
    className={cn("justify-between", className)}
    size="default"
    variant="outline"
  >
    {children}
    <ChevronsUpDownIcon />
  </ButtonFace>
);

export const ListPropertyControlsPending = () => (
  <>
    <ListSelectFace className="w-44">
      <PendingText barClassName="w-8" id="common.add" />
    </ListSelectFace>
    <ButtonFace size="sm" variant="outline">
      <AddLabel />
    </ButtonFace>
  </>
);

export const ListDetailPending = () => (
  <ListDetailShell
    busy
    createItem={
      <div className="flex items-center gap-2">
        <InputFace>
          <PendingText id="templates.addItem" />
        </InputFace>
        <ListSelectFace className="w-40">
          <PendingText barClassName="w-10" id="search.kinds.task" />
        </ListSelectFace>
        <ButtonFace size="default" variant="default">
          <AddLabel />
        </ButtonFace>
      </div>
    }
    heading={
      <h2 className="min-w-0 text-lg font-semibold">
        <FaceLabelPending className="w-32" />
      </h2>
    }
    tools={
      <div className="flex items-center gap-2">
        <InputFace className="w-44">
          <PendingText barClassName="w-16" id="common.category" />
        </InputFace>
        <ButtonFace size="sm" variant="outline">
          <AddLabel />
        </ButtonFace>
        <ListPropertyControlsPending />
        <span className="text-muted-foreground rounded-md border px-2 py-1 text-xs">
          <FaceLabelPending className="w-3" />
        </span>
      </div>
    }
  >
    <ListTableScroll>
      <ListTable>
        <ListTableRowsPending />
      </ListTable>
    </ListTableScroll>
  </ListDetailShell>
);

export const ListsPending = framePendingView(() => (
  <ListsShell
    busy
    createList={
      <div className="flex items-center gap-2">
        <InputFace>
          <PendingText barClassName="w-10" id="common.name" />
        </InputFace>
        <ButtonFace size="icon" variant="default">
          <PlusIcon />
        </ButtonFace>
      </div>
    }
    lists={SKELETON_ROWS.map((key) => (
      <ListSidebarRowPending key={key} />
    ))}
  >
    <ListDetailPending />
  </ListsShell>
));
