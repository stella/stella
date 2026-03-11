import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  CheckIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  FileIcon,
  FilterIcon,
  LayoutGridIcon,
  ListIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stella/ui/components/avatar";
import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import { Skeleton } from "@stella/ui/components/skeleton";
import { toastManager } from "@stella/ui/components/toast";
import {
  TooltipPopup,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from "@stella/ui/components/tooltip";
import { cn } from "@stella/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { useI18nStore } from "@/i18n/i18n-store";
import { getMatterColor } from "@/lib/matter-colors";
import { pageTitle } from "@/lib/page-title";
import { usePinnedStore } from "@/lib/pinned-store";
import { formatRelativeTime } from "@/lib/relative-time";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { justificationsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import {
  useCreateWorkspace,
  useDeleteWorkspace,
} from "@/routes/_protected.workspaces/-mutations";
import {
  overviewOptions,
  workspacesOptions,
} from "@/routes/_protected.workspaces/-queries";

export const Route = createFileRoute("/_protected/workspaces/")({
  head: () => ({
    meta: [{ title: pageTitle("common.matters") }],
  }),
  component: RouteComponent,
  pendingComponent: () => (
    <div className="grid auto-rows-min gap-4 border-t p-4 md:grid-cols-3">
      <Skeleton className="h-22 w-full rounded-xl" />
      <Skeleton className="h-22 w-full rounded-xl" />
      <Skeleton className="h-22 w-full rounded-xl" />
    </div>
  ),
});

export type RouteType = typeof Route;

// -- Types --

type WorkspacesQueryFn = Exclude<
  (typeof workspacesOptions)["queryFn"],
  undefined
>;
type WorkspacesData = Awaited<ReturnType<WorkspacesQueryFn>>;
type Workspace = WorkspacesData["workspaces"][number];

type ViewMode = "grid" | "table";

type MattersSortKey =
  | "name"
  | "reference"
  | "entityCount"
  | "lastActivityAt"
  | "createdAt"
  | "clientName";

type MattersColumnId =
  | "client"
  | "reference"
  | "entityCount"
  | "lastActivityAt"
  | "createdAt";

type MattersGroupBy = "none" | "client";

type MattersConfig = {
  viewMode: ViewMode;
  sortKey: MattersSortKey;
  sortDesc: boolean;
  groupBy: MattersGroupBy;
  visibleColumns: MattersColumnId[];
  clientFilter: string | null;
};

type WorkspaceGroup = {
  clientId: string | null;
  clientName: string;
  workspaces: Workspace[];
};

// -- Helpers --

const MAX_VISIBLE_CONTRIBUTORS = 4;

const getInitials = (name: string | null): string => {
  if (!name) {
    return "?";
  }
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
};

// -- Config persistence --

const CONFIG_KEY = "matters_overview_config";

const ALL_COLUMNS: MattersColumnId[] = [
  "client",
  "reference",
  "entityCount",
  "lastActivityAt",
  "createdAt",
];

const DEFAULT_CONFIG: MattersConfig = {
  viewMode: "grid",
  sortKey: "lastActivityAt",
  sortDesc: true,
  groupBy: "none",
  visibleColumns: ALL_COLUMNS,
  clientFilter: null,
};

const readConfig = (): MattersConfig => {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return {
          ...DEFAULT_CONFIG,
          ...(parsed as Partial<MattersConfig>),
        };
      }
    }
  } catch {
    // localStorage or JSON.parse may throw
  }
  return DEFAULT_CONFIG;
};

const writeConfig = (config: MattersConfig) => {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Silently fail in private browsing
  }
};

// -- Grouping --

const groupByClient = (
  workspaces: Workspace[],
  noClientLabel: string,
): WorkspaceGroup[] => {
  const groups = new Map<string | null, WorkspaceGroup>();

  for (const ws of workspaces) {
    const key = ws.client?.id ?? null;
    let group = groups.get(key);
    if (!group) {
      group = {
        clientId: key,
        clientName: ws.client?.displayName ?? noClientLabel,
        workspaces: [],
      };
      groups.set(key, group);
    }
    group.workspaces.push(ws);
  }

  const result = [...groups.values()];
  result.sort((a, b) => {
    if (a.clientId === null) {
      return 1;
    }
    if (b.clientId === null) {
      return -1;
    }
    return a.clientName.localeCompare(b.clientName);
  });

  return result;
};

// -- Sorting --

const compareFn = (a: Workspace, b: Workspace, key: MattersSortKey): number => {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "reference":
      return (a.reference ?? "").localeCompare(b.reference ?? "");
    case "entityCount":
      return a.entityCount - b.entityCount;
    case "lastActivityAt":
      return (
        new Date(a.lastActivityAt).getTime() -
        new Date(b.lastActivityAt).getTime()
      );
    case "createdAt":
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    case "clientName":
      return (a.client?.displayName ?? "").localeCompare(
        b.client?.displayName ?? "",
      );
    default:
      return 0;
  }
};

// -- Main component --

function RouteComponent() {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(workspacesOptions);
  const createWorkspace = useCreateWorkspace();
  const deleteWorkspace = useDeleteWorkspace();
  const isLimitReached = data.workspaces.length >= data.workspacesCountLimit;
  const { togglePin, isPinned } = usePinnedStore();

  const [config, setConfig] = useState<MattersConfig>(readConfig);
  const [search, setSearch] = useState("");
  const [focusIndex, setFocusIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const updateConfig = useCallback((patch: Partial<MattersConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      writeConfig(next);
      return next;
    });
  }, []);

  const workspaces = data.workspaces;

  // Unique clients for filter menu
  const uniqueClients = useMemo(() => {
    const map = new Map<string, { id: string; displayName: string }>();
    for (const ws of workspaces) {
      if (ws.client) {
        map.set(ws.client.id, ws.client);
      }
    }
    return [...map.values()].toSorted((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }, [workspaces]);

  // Filter pipeline
  const filtered = useMemo(() => {
    let result = workspaces;
    if (config.clientFilter) {
      result = result.filter((w) => w.client?.id === config.clientFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (w) =>
          w.name.toLowerCase().includes(q) ||
          w.reference?.toLowerCase().includes(q) ||
          w.client?.displayName.toLowerCase().includes(q),
      );
    }
    return result;
  }, [workspaces, config.clientFilter, search]);

  // Sort pipeline (applies in both grid and table)
  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const cmp = compareFn(a, b, config.sortKey);
      return config.sortDesc ? -cmp : cmp;
    });
    return copy;
  }, [filtered, config.sortKey, config.sortDesc]);

  // Groups (when grouping enabled)
  const groups = useMemo(() => {
    if (config.groupBy !== "client") {
      return null;
    }
    return groupByClient(sorted, t("workspaces.parties.noClient"));
  }, [sorted, config.groupBy, t]);

  // Flat list for keyboard navigation (matches render order)
  const displayed = useMemo(() => {
    if (groups) {
      return groups.flatMap((g) => g.workspaces);
    }
    return sorted;
  }, [groups, sorted]);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const handleCreateWorkspace = () => {
    const trimmed = newName.trim();
    createWorkspace.mutate(trimmed.length > 0 ? { name: trimmed } : undefined, {
      onSuccess: () => {
        setCreateOpen(false);
        setNewName("");
      },
      onError: () => {
        toastManager.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
      },
    });
  };

  const handleDelete = (workspaceId: string) => {
    if (deleteWorkspace.isPending) {
      return;
    }

    const toastId = toastManager.add({
      title: t("workspaces.deletingWorkspace"),
      type: "loading",
      timeout: Number.POSITIVE_INFINITY,
    });

    deleteWorkspace.mutate(
      { workspaceId },
      {
        onSuccess: () => {
          toastManager.update(toastId, {
            title: t("success.workspaceDeletedSuccessfully"),
            type: "success",
          });
        },
        onError: () => {
          toastManager.update(toastId, {
            title: t("errors.failedToDeleteWorkspace"),
            type: "error",
          });
        },
      },
    );
  };

  const openMatter = useCallback(
    (id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: id },
      });
    },
    [navigate],
  );

  const handleSort = useCallback(
    (key: MattersSortKey) => {
      if (config.sortKey === key) {
        updateConfig({ sortDesc: !config.sortDesc });
      } else {
        updateConfig({ sortKey: key, sortDesc: true });
      }
    },
    [config.sortKey, config.sortDesc, updateConfig],
  );

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !e.ctrlKey &&
        !e.metaKey &&
        document.activeElement?.tagName !== "INPUT"
      ) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (e.key === "Escape") {
        setSearch("");
        setFocusIndex(-1);
        searchRef.current?.blur();
        return;
      }

      if (displayed.length === 0) {
        return;
      }

      if (document.activeElement?.tagName === "INPUT") {
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        setFocusIndex((prev) => (prev < displayed.length - 1 ? prev + 1 : 0));
      }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        setFocusIndex((prev) => (prev > 0 ? prev - 1 : displayed.length - 1));
      }
      if (e.key === "Enter" && focusIndex >= 0) {
        const target = displayed.at(focusIndex);
        if (target) {
          e.preventDefault();
          openMatter(target.id);
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [displayed, focusIndex, openMatter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <MattersToolbar
        clients={uniqueClients}
        config={config}
        createOpen={createOpen}
        isCreating={createWorkspace.isPending}
        isLimitReached={isLimitReached}
        newName={newName}
        onChange={updateConfig}
        onCreateOpenChange={setCreateOpen}
        onCreateWorkspace={handleCreateWorkspace}
        onNewNameChange={setNewName}
        onSearchChange={setSearch}
        onViewModeToggle={() =>
          updateConfig({
            viewMode: config.viewMode === "grid" ? "table" : "grid",
          })
        }
        search={search}
        searchRef={searchRef}
      />

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {displayed.length === 0 ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
            {workspaces.length === 0
              ? t("workspaces.noMatters")
              : t("common.empty")}
          </div>
        ) : config.viewMode === "grid" ? (
          groups ? (
            <div
              className="grid auto-rows-min gap-3 p-4 md:grid-cols-3"
              ref={gridRef}
            >
              {groups.map((group) => {
                const baseIndex = displayed.indexOf(group.workspaces[0]);
                return (
                  <Fragment key={group.clientId ?? "__none__"}>
                    <ClientGroupHeader
                      clientId={group.clientId}
                      clientName={group.clientName}
                      matterCount={group.workspaces.length}
                    />
                    {group.workspaces.map((workspace, i) => (
                      <MatterCard
                        focused={focusIndex === baseIndex + i}
                        hideClientName
                        isPinned={isPinned(workspace.id)}
                        key={workspace.id}
                        lang={lang}
                        onDelete={handleDelete}
                        onTogglePin={togglePin}
                        workspace={workspace}
                      />
                    ))}
                  </Fragment>
                );
              })}
            </div>
          ) : (
            <div
              className="grid auto-rows-min gap-3 p-4 md:grid-cols-3"
              ref={gridRef}
            >
              {displayed.map((workspace, i) => (
                <MatterCard
                  focused={focusIndex === i}
                  isPinned={isPinned(workspace.id)}
                  key={workspace.id}
                  lang={lang}
                  onDelete={handleDelete}
                  onTogglePin={togglePin}
                  workspace={workspace}
                />
              ))}
            </div>
          )
        ) : (
          <MatterTable
            config={config}
            focusIndex={focusIndex}
            groups={groups}
            lang={lang}
            onOpen={openMatter}
            onSort={handleSort}
            workspaces={displayed}
          />
        )}
      </div>
    </div>
  );
}

// -- Toolbar --

type MattersToolbarProps = {
  config: MattersConfig;
  clients: { id: string; displayName: string }[];
  onChange: (patch: Partial<MattersConfig>) => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onViewModeToggle: () => void;
  isLimitReached: boolean;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  newName: string;
  onNewNameChange: (value: string) => void;
  onCreateWorkspace: () => void;
  isCreating: boolean;
};

const SORT_KEYS: MattersSortKey[] = [
  "name",
  "reference",
  "entityCount",
  "lastActivityAt",
  "createdAt",
  "clientName",
];

const MattersToolbar = ({
  config,
  clients,
  onChange,
  search,
  onSearchChange,
  searchRef,
  onViewModeToggle,
  isLimitReached,
  createOpen,
  onCreateOpenChange,
  newName,
  onNewNameChange,
  onCreateWorkspace,
  isCreating,
}: MattersToolbarProps) => {
  const t = useTranslations();
  const canCreateWorkspace = usePermissions({ workspace: ["create"] });
  const [searchFocused, setSearchFocused] = useState(false);

  const sortLabels: Record<MattersSortKey, string> = {
    name: t("billing.matter"),
    reference: t("common.reference"),
    entityCount: t("workspaces.overview.totalItems"),
    lastActivityAt: t("workspaces.lastActive", {
      time: "",
    }).trim(),
    createdAt: t("common.createdAt", { date: "" }).trim(),
    clientName: t("workspaces.parties.client"),
  };

  const activeClient = clients.find((c) => c.id === config.clientFilter);

  return (
    <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1">
      {/* Client filter */}
      {activeClient && (
        <span className="bg-muted/50 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs">
          <span className="font-medium">{t("workspaces.parties.client")}</span>
          <span className="text-muted-foreground">
            {activeClient.displayName}
          </span>
          <Button
            className="ms-0.5 size-5"
            onClick={() => onChange({ clientFilter: null })}
            size="icon"
            variant="ghost"
          >
            <XIcon className="size-3" />
          </Button>
        </span>
      )}
      <ClientFilterDropdown
        clients={clients}
        onSelect={(id) => onChange({ clientFilter: id })}
        selected={config.clientFilter}
      />

      <ToolbarSeparator />

      {/* Sort */}
      <SortChip
        desc={config.sortDesc}
        label={sortLabels[config.sortKey]}
        onToggle={() => onChange({ sortDesc: !config.sortDesc })}
      />
      <Menu>
        <MenuTrigger
          render={<Button className="gap-1" size="xs" variant="ghost" />}
        >
          <ArrowUpDownIcon className="size-3" />
          {t("common.sort")}
        </MenuTrigger>
        <MenuPopup>
          {SORT_KEYS.map((key) => (
            <MenuItem
              key={key}
              onClick={() => onChange({ sortKey: key, sortDesc: true })}
            >
              <span className="flex-1">{sortLabels[key]}</span>
              {config.sortKey === key && (
                <CheckIcon className="text-primary size-3" />
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>

      <ToolbarSeparator />

      {/* Group by */}
      <span className="flex items-center gap-1 text-xs">
        <span className="text-muted-foreground">
          {t("workspaces.views.groupBy")}
        </span>
        <Menu>
          <MenuTrigger
            render={
              <Button className="h-6 gap-1 text-xs" size="xs" variant="ghost" />
            }
          >
            {config.groupBy === "client"
              ? t("workspaces.parties.client")
              : t("workspaces.noGrouping")}
          </MenuTrigger>
          <MenuPopup>
            <MenuItem onClick={() => onChange({ groupBy: "none" })}>
              <span className="flex-1">{t("workspaces.noGrouping")}</span>
              {config.groupBy === "none" && (
                <CheckIcon className="text-primary size-3" />
              )}
            </MenuItem>
            <MenuItem onClick={() => onChange({ groupBy: "client" })}>
              <span className="flex-1">{t("workspaces.parties.client")}</span>
              {config.groupBy === "client" && (
                <CheckIcon className="text-primary size-3" />
              )}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </span>

      {config.viewMode === "table" && (
        <>
          <ToolbarSeparator />
          <ColumnsToggle config={config} onChange={onChange} />
        </>
      )}

      {/* Right side: search, view toggle, new matter */}
      <div className="ms-auto flex items-center gap-1">
        <div className="relative">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 z-10 size-3 -translate-y-1/2" />
          <Input
            className={cn(
              "h-7 ps-7 text-xs transition-[width]",
              searchFocused || search ? "w-44" : "w-28",
            )}
            onBlur={() => setSearchFocused(false)}
            onChange={(e) => onSearchChange(e.currentTarget.value)}
            onFocus={() => setSearchFocused(true)}
            placeholder={t("common.search")}
            ref={searchRef}
            value={search}
          />
        </div>
        <ToolbarSeparator />
        <Button
          className="gap-1"
          onClick={onViewModeToggle}
          size="xs"
          variant="ghost"
        >
          {config.viewMode === "grid" ? (
            <>
              <ListIcon className="size-3" />
              {t("workspaces.views.layouts.table")}
            </>
          ) : (
            <>
              <LayoutGridIcon className="size-3" />
              {t("workspaces.views.layouts.grid")}
            </>
          )}
        </Button>
        {!isLimitReached && canCreateWorkspace && (
          <Popover
            onOpenChange={(open) => {
              onCreateOpenChange(open);
              if (!open) {
                onNewNameChange("");
              }
            }}
            open={createOpen}
          >
            <PopoverTrigger render={<Button disabled={isCreating} size="xs" />}>
              <PlusIcon className="size-3" />
              {t("workspaces.newMatter")}
            </PopoverTrigger>
            <PopoverPopup align="end" className="w-72" sideOffset={4}>
              <div className="flex flex-col gap-3 p-1">
                <Input
                  autoFocus
                  onChange={(e) => onNewNameChange(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onCreateWorkspace();
                    }
                    if (e.key === "Escape") {
                      onCreateOpenChange(false);
                      onNewNameChange("");
                    }
                  }}
                  placeholder={t("workspaces.defaultName")}
                  value={newName}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={() => {
                      onCreateOpenChange(false);
                      onNewNameChange("");
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    disabled={isCreating}
                    onClick={onCreateWorkspace}
                    size="sm"
                  >
                    {t("workspaces.createNewWorkspace")}
                  </Button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        )}
      </div>
    </div>
  );
};

// -- Client filter dropdown --

type ClientFilterDropdownProps = {
  clients: { id: string; displayName: string }[];
  selected: string | null;
  onSelect: (id: string | null) => void;
};

const ClientFilterDropdown = ({
  clients,
  selected,
  onSelect,
}: ClientFilterDropdownProps) => {
  const t = useTranslations();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query) {
      return clients;
    }
    const lower = query.toLowerCase();
    return clients.filter((c) => c.displayName.toLowerCase().includes(lower));
  }, [clients, query]);

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger
        render={<Button className="gap-1" size="xs" variant="ghost" />}
      >
        <FilterIcon className="size-3" />
        {t("common.filter")}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-52">
        <Input
          autoFocus
          className="mb-2"
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("contacts.search")}
          size="sm"
          value={query}
        />
        <div className="-mx-2 max-h-48 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-center text-xs">
              {t("contacts.noContactsFound")}
            </p>
          ) : (
            filtered.map((client) => (
              <button
                className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm"
                key={client.id}
                onClick={() => onSelect(client.id)}
                type="button"
              >
                <span className="flex-1 truncate">{client.displayName}</span>
                {selected === client.id && (
                  <CheckIcon className="text-primary size-3 shrink-0" />
                )}
              </button>
            ))
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
};

const ToolbarSeparator = () => <span className="bg-border mx-1 h-4 w-px" />;

// -- Sort chip --

type SortChipProps = {
  label: string;
  desc: boolean;
  onToggle: () => void;
};

const SortChip = ({ label, desc, onToggle }: SortChipProps) => {
  const SortIcon = desc ? ArrowDownIcon : ArrowUpIcon;

  return (
    <span className="bg-muted/50 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs">
      <Button
        className="flex h-auto items-center gap-1 p-0 font-medium"
        onClick={onToggle}
        variant="ghost"
      >
        <SortIcon className="size-3" />
        {label}
      </Button>
    </span>
  );
};

// -- Columns toggle --

type ColumnsToggleProps = {
  config: MattersConfig;
  onChange: (patch: Partial<MattersConfig>) => void;
};

const ColumnsToggle = ({ config, onChange }: ColumnsToggleProps) => {
  const t = useTranslations();

  const columnLabels: Record<MattersColumnId, string> = {
    client: t("workspaces.parties.client"),
    reference: t("common.reference"),
    entityCount: t("workspaces.overview.totalItems"),
    lastActivityAt: t("workspaces.lastActive", {
      time: "",
    }).trim(),
    createdAt: t("common.createdAt", { date: "" }).trim(),
  };

  const toggle = (id: MattersColumnId) => {
    const current = config.visibleColumns;
    const next = current.includes(id)
      ? current.filter((c) => c !== id)
      : [...current, id];
    if (next.length === 0) {
      return;
    }
    onChange({ visibleColumns: next });
  };

  return (
    <Menu>
      <MenuTrigger
        render={<Button className="gap-1" size="xs" variant="ghost" />}
      >
        <EyeIcon className="size-3" />
        {t("common.columns")}
      </MenuTrigger>
      <MenuPopup>
        <MenuGroup>
          <MenuGroupLabel>{t("common.columns")}</MenuGroupLabel>
          {ALL_COLUMNS.map((colId) => {
            const isVisible = config.visibleColumns.includes(colId);
            return (
              <MenuItem key={colId} onClick={() => toggle(colId)}>
                <span className="flex-1">{columnLabels[colId]}</span>
                {isVisible && <CheckIcon className="text-primary size-3" />}
              </MenuItem>
            );
          })}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
};

// -- Client group header --

type ClientGroupHeaderProps = {
  clientId: string | null;
  clientName: string;
  matterCount: number;
};

const ClientGroupHeader = ({
  clientId,
  clientName,
  matterCount,
}: ClientGroupHeaderProps) => (
  <div
    className={cn(
      "sticky top-0 z-10 col-span-full",
      "flex items-center gap-2",
      "bg-background/95 border-b backdrop-blur-sm",
      "pt-4 pb-2 first:pt-0",
    )}
  >
    <h3 className="text-sm font-semibold">
      {clientId ? (
        <Link
          className="hover:underline"
          params={{ contactId: clientId }}
          to="/contacts/$contactId"
        >
          {clientName}
        </Link>
      ) : (
        clientName
      )}
    </h3>
    <span
      className={cn(
        "bg-muted rounded-full px-1.5 py-0.5",
        "text-muted-foreground text-[0.625rem] tabular-nums",
      )}
    >
      {matterCount}
    </span>
  </div>
);

// -- Grid card --

type MatterCardProps = {
  workspace: Workspace;
  lang: string;
  focused: boolean;
  hideClientName?: boolean;
  isPinned: boolean;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
};

const HOVER_DELAY = 400;

const MatterCard = ({
  workspace,
  lang,
  focused,
  hideClientName,
  isPinned,
  onTogglePin,
  onDelete,
}: MatterCardProps) => {
  const t = useTranslations();
  const relTime = formatRelativeTime(workspace.lastActivityAt, lang);

  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [hovered, setHovered] = useState(false);
  // eslint-disable-next-line unicorn/no-useless-undefined -- React 19 useRef requires an explicit initial value
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { data: preview } = useQuery({
    ...overviewOptions(workspace.id),
    enabled: previewEnabled,
  });

  const qc = useQueryClient();
  const onMouseEnter = useCallback(() => {
    setHovered(true);
    hoverTimer.current = setTimeout(() => setPreviewEnabled(true), HOVER_DELAY);
    // Prefetch workspace data so clicking feels instant
    const id = workspace.id;
    // eslint-disable-next-line typescript/no-floating-promises
    qc.prefetchQuery(viewsOptions(id, qc));
    // eslint-disable-next-line typescript/no-floating-promises
    qc.prefetchQuery(
      entitiesOptions({ workspaceId: id, filters: [], sorts: [], page: 1 }),
    );
    // eslint-disable-next-line typescript/no-floating-promises
    qc.prefetchQuery(propertiesOptions(id));
    // eslint-disable-next-line typescript/no-floating-promises
    qc.prefetchQuery(justificationsOptions(id));
  }, [qc, workspace.id]);

  const onMouseLeave = useCallback(() => {
    setHovered(false);
    setPreviewEnabled(false);
    clearTimeout(hoverTimer.current);
  }, []);

  const others = workspace.contributors.filter((c) => c.userId !== null);
  const visibleContributors = others.slice(0, MAX_VISIBLE_CONTRIBUTORS);
  const overflow = others.length - MAX_VISIBLE_CONTRIBUTORS;

  const hasPreviewContent =
    !!preview &&
    (preview.documentCount > 0 ||
      preview.taskCount > 0 ||
      preview.recentEntities.length > 0);
  const tooltipOpen = hovered && hasPreviewContent;

  return (
    <TooltipRoot open={tooltipOpen}>
      <TooltipTrigger
        render={
          <Link
            className={cn(
              "group bg-card hover:bg-accent/50 relative flex h-auto min-h-22 flex-col justify-between overflow-hidden rounded-xl border py-2.5 ps-3 pe-3 transition-colors",
              focused && "ring-primary ring-2",
            )}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            params={{ workspaceId: workspace.id }}
            style={{
              borderLeftWidth: 3,
              borderLeftColor: getMatterColor(workspace.id),
            }}
            to="/workspaces/$workspaceId"
          />
        }
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{workspace.name}</h2>
            {!hideClientName && workspace.client && (
              <Link
                className="text-muted-foreground hover:text-foreground truncate text-xs hover:underline"
                onClick={(e) => e.stopPropagation()}
                params={{ contactId: workspace.client.id }}
                to="/contacts/$contactId"
              >
                {workspace.client.displayName}
              </Link>
            )}
          </div>

          {/* Three-dots menu */}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <EllipsisVerticalIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup
              align="end"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              sideOffset={4}
            >
              <MenuItem onClick={() => onTogglePin(workspace.id)}>
                {isPinned ? <PinOffIcon /> : <PinIcon />}
                {isPinned ? t("common.unpin") : t("common.pin")}
              </MenuItem>
              <MenuItem
                onClick={() => onDelete(workspace.id)}
                variant="destructive"
              >
                <Trash2Icon />
                {t("common.delete")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>

        {/* Contributors */}
        {visibleContributors.length > 0 && (
          <div className="flex items-center py-0.5">
            {visibleContributors.map((c, i) => (
              <TooltipRoot key={c.userId}>
                <TooltipTrigger
                  className={cn("rounded-full", i > 0 && "-ms-1")}
                  render={<span />}
                >
                  <Avatar className="ring-background size-5 ring-1">
                    {c.userImage && <AvatarImage src={c.userImage} />}
                    <AvatarFallback className="text-[0.5rem]">
                      {getInitials(c.userName)}
                    </AvatarFallback>
                  </Avatar>
                </TooltipTrigger>
                <TooltipPopup>{c.userName}</TooltipPopup>
              </TooltipRoot>
            ))}
            {overflow > 0 && (
              <span className="text-muted-foreground ms-1 text-[0.625rem]">
                {`+${overflow}`}
              </span>
            )}
          </div>
        )}

        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {workspace.reference && (
            <>
              <span className="font-mono">{workspace.reference}</span>
              <span>·</span>
            </>
          )}
          <span>
            {workspace.entityCount > 0
              ? t("workspaces.entitiesCount", {
                  count: workspace.entityCount,
                })
              : t("workspaces.noItems")}
          </span>
          <span>·</span>
          <span
            title={new Date(workspace.lastActivityAt).toLocaleString(lang, {
              dateStyle: "full",
              timeStyle: "medium",
            })}
          >
            {t("workspaces.lastActive", { time: relTime })}
          </span>
        </div>
      </TooltipTrigger>

      {hasPreviewContent && (
        <TooltipPopup className="w-64 p-0" side="bottom">
          <div className="p-3">
            {(preview.documentCount > 0 || preview.taskCount > 0) && (
              <div className="mb-2 flex gap-1">
                <div className="bg-muted flex-1 rounded px-2 py-1 text-center text-xs tabular-nums">
                  {t("workspaces.documentsCount", {
                    count: preview.documentCount,
                  })}
                </div>
                {preview.taskCount > 0 && (
                  <div className="bg-muted flex-1 rounded px-2 py-1 text-center text-xs tabular-nums">
                    {t("workspaces.tasksCount", {
                      count: preview.taskCount,
                    })}
                  </div>
                )}
              </div>
            )}
            {preview.recentEntities.slice(0, 3).map((entity) => (
              <div
                className="flex items-center gap-2 py-1 text-xs"
                key={entity.entityId}
              >
                {entity.mimeType ? (
                  <DocumentIcon
                    className="size-3.5 shrink-0"
                    mimeType={entity.mimeType}
                  />
                ) : (
                  <FileIcon className="text-muted-foreground size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{entity.name}</span>
                {entity.updatedAt && (
                  <span className="text-muted-foreground shrink-0">
                    {formatRelativeTime(entity.updatedAt, lang)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </TooltipPopup>
      )}
    </TooltipRoot>
  );
};

// -- Table view --

type MatterTableProps = {
  workspaces: Workspace[];
  groups: WorkspaceGroup[] | null;
  lang: string;
  focusIndex: number;
  config: MattersConfig;
  onOpen: (id: string) => void;
  onSort: (key: MattersSortKey) => void;
};

const TRAILING_WHITESPACE = /\s*$/;

const MatterTable = ({
  workspaces,
  groups,
  lang,
  focusIndex,
  config,
  onOpen,
  onSort,
}: MatterTableProps) => {
  const t = useTranslations();

  type ColumnDef = {
    key: MattersSortKey;
    label: string;
    className?: string;
    render: (ws: Workspace) => React.ReactNode;
  };

  const allColumns: ColumnDef[] = [
    {
      key: "name",
      label: t("billing.matter"),
      render: (ws) => (
        <div className="flex items-center gap-2">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{
              backgroundColor: getMatterColor(ws.id),
            }}
          />
          <span className="font-medium">{ws.name}</span>
        </div>
      ),
    },
    {
      key: "clientName",
      label: t("workspaces.parties.client"),
      className: "hidden md:table-cell",
      render: (ws) => (
        <span className="text-muted-foreground">
          {ws.client?.displayName ?? "—"}
        </span>
      ),
    },
    {
      key: "reference",
      label: t("common.reference"),
      className: "hidden md:table-cell",
      render: (ws) => (
        <span className="text-muted-foreground font-mono">
          {ws.reference ?? "—"}
        </span>
      ),
    },
    {
      key: "entityCount",
      label: t("workspaces.overview.totalItems"),
      className: "hidden md:table-cell text-end",
      render: (ws) => (
        <span className="text-muted-foreground tabular-nums">
          {ws.entityCount}
        </span>
      ),
    },
    {
      key: "lastActivityAt",
      label: t("workspaces.lastActive", { time: "" }).replace(
        TRAILING_WHITESPACE,
        "",
      ),
      render: (ws) => (
        <span
          className="text-muted-foreground"
          title={new Date(ws.lastActivityAt).toLocaleString(lang, {
            dateStyle: "full",
            timeStyle: "medium",
          })}
        >
          {formatRelativeTime(ws.lastActivityAt, lang)}
        </span>
      ),
    },
    {
      key: "createdAt",
      label: t("common.createdAt", { date: "" }).replace(
        TRAILING_WHITESPACE,
        "",
      ),
      className: "hidden lg:table-cell",
      render: (ws) => (
        <span className="text-muted-foreground">
          {new Date(ws.createdAt).toLocaleDateString(lang)}
        </span>
      ),
    },
  ];

  // "name" is always visible; others controlled by config
  const SORT_KEY_TO_COLUMN_ID: Partial<
    Record<MattersSortKey, MattersColumnId>
  > = {
    clientName: "client",
    reference: "reference",
    entityCount: "entityCount",
    lastActivityAt: "lastActivityAt",
    createdAt: "createdAt",
  };

  const columns = allColumns.filter((col) => {
    const colId = SORT_KEY_TO_COLUMN_ID[col.key];
    if (!colId) {
      return true; // "name" always visible
    }
    return config.visibleColumns.includes(colId);
  });

  const renderRow = (ws: Workspace, globalIndex: number) => (
    <tr
      className={cn(
        "hover:bg-accent/50 cursor-pointer border-b transition-colors",
        focusIndex === globalIndex && "bg-accent/50",
      )}
      key={ws.id}
      onClick={() => onOpen(ws.id)}
    >
      {columns.map((col) => (
        <td className={cn("px-3 py-2", col.className)} key={col.key}>
          {col.render(ws)}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="overflow-x-auto px-4 pb-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-start text-xs">
            {columns.map((col) => (
              <th
                className={cn(
                  "hover:text-foreground cursor-pointer px-3 py-2 font-medium select-none",
                  col.className,
                )}
                key={col.key}
                onClick={() => onSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {config.sortKey === col.key && (
                    <span className="text-[0.5rem]">
                      {config.sortDesc ? "▼" : "▲"}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups
            ? groups.map((group) => {
                const baseIndex = workspaces.indexOf(group.workspaces[0]);
                return (
                  <Fragment key={group.clientId ?? "__none__"}>
                    <tr className="group/header bg-muted/30 first:border-t-0 [&:not(:first-child)]:border-t-8 [&:not(:first-child)]:border-transparent">
                      <td
                        className="px-3 py-2 text-sm font-semibold"
                        colSpan={columns.length}
                      >
                        <span className="inline-flex items-center gap-2">
                          {group.clientId ? (
                            <Link
                              className="hover:underline"
                              params={{
                                contactId: group.clientId,
                              }}
                              to="/contacts/$contactId"
                            >
                              {group.clientName}
                            </Link>
                          ) : (
                            group.clientName
                          )}
                          <span
                            className={cn(
                              "bg-muted rounded-full px-1.5 py-0.5",
                              "text-[0.625rem] tabular-nums",
                              "text-muted-foreground font-normal",
                            )}
                          >
                            {group.workspaces.length}
                          </span>
                        </span>
                      </td>
                    </tr>
                    {group.workspaces.map((ws, i) =>
                      renderRow(ws, baseIndex + i),
                    )}
                  </Fragment>
                );
              })
            : workspaces.map((ws, i) => renderRow(ws, i))}
        </tbody>
      </table>
    </div>
  );
};
