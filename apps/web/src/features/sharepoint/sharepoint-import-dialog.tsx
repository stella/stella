import { Fragment, type ReactNode, useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { SHAREPOINT_IMPORT_MAX_ITEMS } from "@stll/api-contract/sharepoint";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@stll/ui/breadcrumb";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
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
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  ChevronRightIcon,
  GlobeIcon,
  LibraryIcon,
  UserIcon,
} from "@stll/ui/icons";
import {
  List,
  ListEmpty,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemStatus,
  ListItemTitle,
  type StatusTone,
} from "@stll/ui/list";
import { Loader } from "@stll/ui/loader";
import { SearchField } from "@stll/ui/search-field";
import { stellaToast } from "@stll/ui/toast";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import {
  apiCodeMessage,
  APIError,
  RETRY_AFTER_MS_DETAIL,
  unwrapApiResponse,
} from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { formatFileSize } from "@/lib/file-size";
import { formatRelativeTime } from "@/lib/relative-time";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

import {
  SHAREPOINT_ACCESS,
  SHAREPOINT_CONNECTION_STATE,
  sharepointConnectionState,
} from "./sharepoint-access.logic";
import {
  useSharepointAccess,
  useSharepointConnect,
  useSharepointViewer,
} from "./sharepoint-hooks";
import {
  deferredSharepointFiles,
  isSharepointFileSelected,
  openSharepointDrive,
  openSharepointFolder,
  openSharepointSource,
  SHAREPOINT_PICKER_START,
  sharepointBreadcrumb,
  type SharepointBrowseRefusal,
  sharepointBrowseRefusal,
  type SharepointCrumbLabel,
  sharepointFolderId,
  type SharepointImportOutcome,
  type SharepointImportSummary,
  sharepointItemAction,
  type SharepointPickerLocation,
  type SharepointSelectedFile,
  summarizeSharepointImport,
  toggleSharepointFile,
} from "./sharepoint-picker.logic";
import {
  sharepointAccessOptions,
  sharepointChildrenOptions,
  sharepointDrivesOptions,
  sharepointSitesOptions,
} from "./sharepoint-queries";

const SITE_SEARCH_DEBOUNCE_MS = 300;

/**
 * One import request stops starting files once its time budget is spent and
 * defers the rest, so it lasts at most that budget plus the file in flight.
 * This covers both, above the client's 30-second default.
 */
const SHAREPOINT_IMPORT_TIMEOUT_MS = 90_000;

type SharepointImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The matter folder new documents land in; `null` is the matter's top level. */
  parentId: string | null;
};

/**
 * Picks up to {@link SHAREPOINT_IMPORT_MAX_ITEMS} files from SharePoint or
 * OneDrive and copies them into the matter folder that is open.
 */
export const SharepointImportDialog = ({
  open,
  onOpenChange,
  workspaceId,
  parentId,
}: SharepointImportDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {/* Mount only while open so each open starts at the site list. */}
    {open ? (
      <SharepointImportDialogBody
        onClose={() => onOpenChange(false)}
        parentId={parentId}
        workspaceId={workspaceId}
      />
    ) : null}
  </Dialog>
);

const SharepointImportDialogBody = ({
  onClose,
  workspaceId,
  parentId,
}: {
  onClose: () => void;
  workspaceId: string;
  parentId: string | null;
}) => {
  const t = useTranslations();
  const access = useSharepointAccess();
  const [summary, setSummary] = useState<SharepointImportSummary | null>(null);

  const body = (() => {
    if (summary !== null) {
      return <ImportResults onClose={onClose} summary={summary} />;
    }
    if (access.type === "error") {
      return (
        <PanelMessage>
          <QueryViewFeedback view={access} />
        </PanelMessage>
      );
    }
    if (access.type !== "items") {
      return <PanelLoader />;
    }
    if (access.items.type !== SHAREPOINT_ACCESS.enabled) {
      // The entry point is hidden in this state; an admin turned it off while
      // the dialog was open.
      return (
        <PanelMessage>
          <p className="text-sm text-pretty">{t("sharepoint.askAdmin")}</p>
        </PanelMessage>
      );
    }
    const state = sharepointConnectionState(access.items.connection);
    switch (state) {
      case SHAREPOINT_CONNECTION_STATE.notConnected:
        return (
          <PanelMessage>
            <ConnectAction refusal={{ type: "not-connected" }} />
          </PanelMessage>
        );
      case SHAREPOINT_CONNECTION_STATE.reconnectRequired:
        return (
          <PanelMessage>
            <ConnectAction refusal={{ type: "reconnect-required" }} />
          </PanelMessage>
        );
      case SHAREPOINT_CONNECTION_STATE.connected:
        return (
          <SharepointBrowser
            onImported={(next) => {
              if (next.failed === 0) {
                stellaToast.add({
                  title: t("sharepoint.import.done"),
                  ...(next.unchanged > 0 && {
                    description: t("sharepoint.import.alreadyCurrent", {
                      count: next.unchanged,
                    }),
                  }),
                  type: "success",
                });
                onClose();
              } else {
                setSummary(next);
              }
            }}
            parentId={parentId}
            workspaceId={workspaceId}
          />
        );
      default:
        state satisfies never;
        return panic("Unknown SharePoint connection state");
    }
  })();

  return (
    <DialogPopup size="lg">
      <DialogHeader>
        <DialogTitle>{t("sharepoint.picker.title")}</DialogTitle>
        <DialogDescription>
          {summary === null
            ? t("sharepoint.picker.description", {
                max: SHAREPOINT_IMPORT_MAX_ITEMS,
              })
            : t("sharepoint.import.partial", {
                failed: summary.failed,
                total: summary.outcomes.length,
              })}
        </DialogDescription>
      </DialogHeader>
      {body}
    </DialogPopup>
  );
};

const PanelLoader = () => {
  const t = useTranslations();
  return (
    <DialogPanel className="flex min-h-80 items-center justify-center">
      <Loader label={t("common.loading")} />
    </DialogPanel>
  );
};

const PanelMessage = ({ children }: { children: ReactNode }) => (
  <DialogPanel className="flex min-h-80 flex-col justify-center">
    {children}
  </DialogPanel>
);

/** Connect or reconnect, where a lost or missing grant stops browsing. */
const ConnectAction = ({
  refusal,
}: {
  refusal: Extract<
    SharepointBrowseRefusal,
    { type: "not-connected" | "reconnect-required" }
  >;
}) => {
  const t = useTranslations();
  const connect = useSharepointConnect();
  const reconnect = refusal.type === "reconnect-required";
  return (
    <div className="flex flex-col items-start gap-3 py-6 text-sm">
      <p className="text-pretty">
        {reconnect
          ? t("sharepoint.picker.reconnectRequired")
          : t("sharepoint.picker.notConnected")}
      </p>
      <Button
        loading={connect.isPending}
        onClick={() => connect.mutate()}
        size="sm"
      >
        {reconnect ? t("common.reconnect") : t("common.connect")}
      </Button>
    </div>
  );
};

const crumbLabel = (
  label: SharepointCrumbLabel,
  names: { sites: string; onedrive: string },
): string => {
  switch (label.type) {
    case "sites":
      return names.sites;
    case "onedrive":
      return names.onedrive;
    case "name":
      return label.name;
    default:
      label satisfies never;
      return panic("Unknown SharePoint crumb");
  }
};

/** One import request: the API stores what fits its time budget and defers the rest. */
const postImportRound = async ({
  workspaceId,
  parentId,
  files,
}: {
  workspaceId: string;
  parentId: string | null;
  files: readonly SharepointSelectedFile[];
}) => {
  const { results } = unwrapApiResponse(
    await api.sharepoint.imports({ workspaceId }).post(
      {
        items: files.map(({ driveId, itemId }) => ({ driveId, itemId })),
        parentId,
      },
      { fetch: { timeoutMs: SHAREPOINT_IMPORT_TIMEOUT_MS } },
    ),
  );
  return results;
};

type ImportRoundResult = Awaited<ReturnType<typeof postImportRound>>[number];

const SharepointBrowser = ({
  workspaceId,
  parentId,
  onImported,
}: {
  workspaceId: string;
  parentId: string | null;
  onImported: (summary: SharepointImportSummary) => void;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const viewer = useSharepointViewer();
  const [location, setLocation] = useState<SharepointPickerLocation>(
    SHAREPOINT_PICKER_START,
  );
  const [selection, setSelection] = useState<readonly SharepointSelectedFile[]>(
    [],
  );
  const crumbs = sharepointBreadcrumb(location);
  const crumbNames = {
    sites: t("sharepoint.picker.sites"),
    onedrive: t("sharepoint.picker.myOneDrive"),
  };
  const full = selection.length >= SHAREPOINT_IMPORT_MAX_ITEMS;

  // How many picked files have settled while an import runs in rounds.
  const [settledCount, setSettledCount] = useState(0);

  const importFiles = useMutation({
    mutationFn: async (files: readonly SharepointSelectedFile[]) => {
      const results: ImportRoundResult[] = [];
      let pending = files;
      setSettledCount(0);
      while (pending.length > 0) {
        // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- each round re-sends only the files the previous round deferred, so it needs that answer first
        const round = await postImportRound({
          workspaceId,
          parentId,
          files: pending,
        });
        results.push(...round);
        const deferred = deferredSharepointFiles(files, results);
        // A round that settles nothing would repeat forever; its files stay
        // deferred and the summary reports them as unfinished.
        if (deferred.length >= pending.length) {
          break;
        }
        pending = deferred;
        setSettledCount(files.length - pending.length);
      }
      return results;
    },
    onSuccess: async (results, files) => {
      const summary = summarizeSharepointImport(files, results);
      if (summary.created + summary.versioned > 0) {
        await queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        });
      }
      onImported(summary);
    },
    onError: async (error) => {
      notifyUserError(error, t("errors.actionFailed"));
      // A failed or timed-out request may still have stored some files before
      // it ended, so the matter's documents are read again either way.
      await queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
      // A lost grant shows the connect prompt in place of the picker.
      const refusal = browseRefusal(error).type;
      if (refusal === "not-connected" || refusal === "reconnect-required") {
        await queryClient.invalidateQueries({
          queryKey: sharepointAccessOptions(viewer).queryKey,
        });
      }
    },
  });

  const footerStatus = () => {
    if (importFiles.isPending) {
      // Deferred files are still in progress, not failures: the next round
      // sends them again.
      return t("sharepoint.import.progress", {
        done: settledCount,
        total: selection.length,
      });
    }
    return full
      ? t("sharepoint.picker.selectionLimit", {
          max: SHAREPOINT_IMPORT_MAX_ITEMS,
        })
      : t("sharepoint.picker.selectedCount", { count: selection.length });
  };

  const toggle = (file: SharepointSelectedFile) => {
    const change = toggleSharepointFile(selection, file);
    if (change.type === "changed") {
      setSelection(change.selection);
    }
  };

  return (
    <>
      <DialogPanel className="flex min-h-80 flex-col gap-3">
        <Breadcrumb>
          <BreadcrumbList>
            {crumbs.map((crumb, index) => {
              const label = crumbLabel(crumb.label, crumbNames);
              const current = index === crumbs.length - 1;
              return (
                <Fragment key={crumb.key}>
                  {index > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem className="min-w-0">
                    {current ? (
                      <BreadcrumbPage>
                        <bdi className="truncate">{label}</bdi>
                      </BreadcrumbPage>
                    ) : (
                      <Button
                        className="max-w-48"
                        onClick={() => setLocation(crumb.target)}
                        size="xs"
                        variant="ghost"
                      >
                        <bdi className="truncate">{label}</bdi>
                      </Button>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
        <LocationList
          full={full}
          location={location}
          onNavigate={setLocation}
          onToggle={toggle}
          selection={selection}
        />
      </DialogPanel>
      <DialogFooter className="items-center">
        <p
          aria-live="polite"
          className="text-muted-foreground me-auto text-xs tabular-nums"
        >
          {footerStatus()}
        </p>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={selection.length === 0}
          loading={importFiles.isPending}
          onClick={() => importFiles.mutate(selection)}
        >
          {t("common.import")}
        </Button>
      </DialogFooter>
    </>
  );
};

type LocationListProps = {
  location: SharepointPickerLocation;
  selection: readonly SharepointSelectedFile[];
  full: boolean;
  onNavigate: (location: SharepointPickerLocation) => void;
  onToggle: (file: SharepointSelectedFile) => void;
};

const LocationList = ({
  location,
  selection,
  full,
  onNavigate,
  onToggle,
}: LocationListProps) => {
  switch (location.type) {
    case "sites":
      return <SitesList onNavigate={onNavigate} />;
    case "drives":
      return <DrivesList location={location} onNavigate={onNavigate} />;
    case "folder":
      return (
        <FolderList
          full={full}
          location={location}
          onNavigate={onNavigate}
          onToggle={onToggle}
          selection={selection}
        />
      );
    default:
      location satisfies never;
      return panic("Unknown SharePoint picker location");
  }
};

const browseRefusal = (error: unknown): SharepointBrowseRefusal =>
  APIError.is(error)
    ? sharepointBrowseRefusal({
        code: error.code,
        retryAfterMs: error.details?.[RETRY_AFTER_MS_DETAIL],
      })
    : { type: "other" };

/** A failed listing: the connect prompt for a lost grant, otherwise a retry. */
const ListFailure = ({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) => {
  const t = useTranslations();
  const refusal = browseRefusal(error);
  const failureMessage = (
    failure: Extract<SharepointBrowseRefusal, { type: "throttled" | "other" }>,
  ) => {
    if (failure.type === "other") {
      return t("common.loadFailed");
    }
    return failure.retryAfterSeconds === null
      ? t("errors.apiCodes.sharepointThrottled")
      : t("sharepoint.picker.throttledFor", {
          seconds: failure.retryAfterSeconds,
        });
  };
  switch (refusal.type) {
    case "not-connected":
    case "reconnect-required":
      return <ConnectAction refusal={refusal} />;
    case "throttled":
    case "other":
      return (
        <div className="flex flex-col items-start gap-2 py-6 text-sm">
          <p className="text-pretty">{failureMessage(refusal)}</p>
          <Button onClick={onRetry} size="sm" variant="outline">
            {t("common.retry")}
          </Button>
        </div>
      );
    default:
      refusal satisfies never;
      return panic("Unknown SharePoint refusal");
  }
};

type PagedList<TItem> = {
  status: "pending" | "error" | "success";
  error: unknown;
  items: readonly TItem[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
};

/** The shared frame of every listing: loading, failure, rows, load more. */
const PagedRows = <TItem,>({
  list,
  empty,
  children,
}: {
  list: PagedList<TItem>;
  empty: string;
  children: (items: readonly TItem[]) => ReactNode;
}) => {
  const t = useTranslations();
  switch (list.status) {
    case "pending":
      return (
        <div className="flex flex-1 items-center justify-center py-10">
          <Loader label={t("common.loading")} />
        </div>
      );
    case "error":
      return (
        <ListFailure
          error={list.error}
          onRetry={() => detached(list.refetch(), "sharepoint-picker.retry")}
        />
      );
    case "success":
      return (
        <div className="flex flex-col gap-2">
          <List>
            {children(list.items)}
            {list.items.length === 0 && <ListEmpty>{empty}</ListEmpty>}
          </List>
          {list.hasNextPage && (
            <Button
              className="self-center"
              loading={list.isFetchingNextPage}
              onClick={() =>
                detached(list.fetchNextPage(), "sharepoint-picker.load-more")
              }
              size="sm"
              variant="ghost"
            >
              {t("common.loadMore")}
            </Button>
          )}
        </div>
      );
    default:
      list.status satisfies never;
      return panic("Unknown listing status");
  }
};

const pagedList = <TItem,>(query: {
  status: "pending" | "error" | "success";
  error: unknown;
  data: { pages: readonly { items: readonly TItem[] }[] } | undefined;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
}): PagedList<TItem> => ({
  status: query.status,
  error: query.error,
  items: query.data?.pages.flatMap((page) => page.items) ?? [],
  hasNextPage: query.hasNextPage,
  isFetchingNextPage: query.isFetchingNextPage,
  fetchNextPage: query.fetchNextPage,
  refetch: query.refetch,
});

const NavigationRow = ({
  icon,
  title,
  description,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  description?: string | null | undefined;
  onOpen: () => void;
}) => (
  <ListItem render={<Button onClick={onOpen} variant="plain" />}>
    <ListItemMedia>{icon}</ListItemMedia>
    <ListItemContent>
      <ListItemTitle>
        <bdi>{title}</bdi>
      </ListItemTitle>
      {description ? (
        <ListItemDescription variant="code">{description}</ListItemDescription>
      ) : null}
    </ListItemContent>
    <ListItemActions>
      <DirectionalIcon
        className="text-foreground-placeholder size-4"
        icon={ChevronRightIcon}
      />
    </ListItemActions>
  </ListItem>
);

const SitesList = ({
  onNavigate,
}: {
  onNavigate: (location: SharepointPickerLocation) => void;
}) => {
  const t = useTranslations();
  const viewer = useSharepointViewer();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const commitSearch = useDebouncedCallback(
    (value: string) => setSearch(value.trim()),
    SITE_SEARCH_DEBOUNCE_MS,
  );
  const list = pagedList(
    useInfiniteQuery(sharepointSitesOptions(viewer, search)),
  );

  return (
    <div className="flex flex-col gap-3">
      <SearchField
        aria-label={t("sharepoint.picker.searchSites")}
        clearLabel={t("common.clearSearch")}
        onValueChange={(value) => {
          setDraft(value);
          commitSearch(value);
        }}
        placeholder={t("sharepoint.picker.searchSites")}
        value={draft}
      />
      {search.length === 0 && (
        <List>
          <NavigationRow
            icon={<UserIcon />}
            onOpen={() =>
              onNavigate(openSharepointSource({ type: "onedrive" }))
            }
            title={t("sharepoint.picker.myOneDrive")}
          />
        </List>
      )}
      <PagedRows
        empty={
          search.length === 0
            ? t("sharepoint.picker.noFollowedSites")
            : t("common.noResults")
        }
        list={list}
      >
        {(sites) =>
          sites.map((site) => (
            <NavigationRow
              description={site.webUrl}
              icon={<GlobeIcon />}
              key={site.id}
              onOpen={() =>
                onNavigate(
                  openSharepointSource({
                    type: "site",
                    site: { id: site.id, name: site.name },
                  }),
                )
              }
              title={site.name}
            />
          ))
        }
      </PagedRows>
    </div>
  );
};

const DrivesList = ({
  location,
  onNavigate,
}: {
  location: Extract<SharepointPickerLocation, { type: "drives" }>;
  onNavigate: (location: SharepointPickerLocation) => void;
}) => {
  const t = useTranslations();
  const viewer = useSharepointViewer();
  const siteId =
    location.source.type === "site" ? location.source.site.id : null;
  const list = pagedList(
    useInfiniteQuery(sharepointDrivesOptions(viewer, siteId)),
  );
  return (
    <PagedRows empty={t("sharepoint.picker.noLibraries")} list={list}>
      {(drives) =>
        drives.map((drive) => (
          <NavigationRow
            icon={<LibraryIcon />}
            key={drive.id}
            onOpen={() =>
              onNavigate(
                openSharepointDrive(location, {
                  id: drive.id,
                  name: drive.name,
                }),
              )
            }
            title={drive.name}
          />
        ))
      }
    </PagedRows>
  );
};

const FolderList = ({
  location,
  selection,
  full,
  onNavigate,
  onToggle,
}: Omit<LocationListProps, "location"> & {
  location: Extract<SharepointPickerLocation, { type: "folder" }>;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const viewer = useSharepointViewer();
  const list = pagedList(
    useInfiniteQuery(
      sharepointChildrenOptions(viewer, {
        driveId: location.drive.id,
        folderId: sharepointFolderId(location),
      }),
    ),
  );
  return (
    <PagedRows empty={t("sharepoint.picker.emptyFolder")} list={list}>
      {(items) =>
        items.map((item) => {
          const action = sharepointItemAction(item.kind);
          switch (action) {
            case "open":
              return (
                <NavigationRow
                  icon={<EntityKindIcon kind="folder" />}
                  key={item.id}
                  onOpen={() =>
                    onNavigate(
                      openSharepointFolder(location, {
                        id: item.id,
                        name: item.name,
                      }),
                    )
                  }
                  title={item.name}
                />
              );
            case "select": {
              const file = {
                driveId: item.driveId,
                itemId: item.id,
                name: item.name,
              };
              const checked = isSharepointFileSelected(selection, file);
              const details = [
                item.lastModifiedAt === null
                  ? null
                  : formatRelativeTime(item.lastModifiedAt),
                item.size === null ? null : formatFileSize(item.size, format),
              ].filter((part) => part !== null);
              return (
                <ListItem key={item.id}>
                  <Checkbox
                    aria-label={item.name}
                    checked={checked}
                    disabled={!checked && full}
                    onCheckedChange={() => onToggle(file)}
                  />
                  <ListItemMedia>
                    <EntityKindIcon
                      fileName={item.name}
                      kind="document"
                      mimeType={item.mimeType}
                    />
                  </ListItemMedia>
                  <ListItemContent>
                    <ListItemTitle>
                      <bdi>{item.name}</bdi>
                    </ListItemTitle>
                    {details.length > 0 && (
                      <ListItemDescription>
                        {details.join(" · ")}
                      </ListItemDescription>
                    )}
                  </ListItemContent>
                </ListItem>
              );
            }
            case "none":
              return (
                <ListItem aria-disabled="true" key={item.id}>
                  <ListItemMedia>
                    <EntityKindIcon fileName={item.name} kind="document" />
                  </ListItemMedia>
                  <ListItemContent>
                    <ListItemTitle>
                      <bdi>{item.name}</bdi>
                    </ListItemTitle>
                    <ListItemDescription>
                      {t("sharepoint.picker.notImportable")}
                    </ListItemDescription>
                  </ListItemContent>
                </ListItem>
              );
            default:
              action satisfies never;
              return panic("Unknown SharePoint item action");
          }
        })
      }
    </PagedRows>
  );
};

const OUTCOME_PRESENTATION = {
  created: { tone: "success", label: "sharepoint.import.created" },
  versioned: { tone: "success", label: "sharepoint.import.versioned" },
  unchanged: { tone: "neutral", label: "sharepoint.import.unchanged" },
  failed: { tone: "destructive", label: "common.failed" },
} as const satisfies Record<
  SharepointImportOutcome["status"],
  { tone: StatusTone; label: TranslationKey }
>;

/** Per-file outcomes after an import in which at least one file failed. */
const ImportResults = ({
  summary,
  onClose,
}: {
  summary: SharepointImportSummary;
  onClose: () => void;
}) => {
  const t = useTranslations();
  return (
    <>
      <DialogPanel>
        <List>
          {summary.outcomes.map((outcome) => {
            const presentation = OUTCOME_PRESENTATION[outcome.status];
            return (
              <ListItem key={outcome.key}>
                <ListItemMedia>
                  <EntityKindIcon fileName={outcome.name} kind="document" />
                </ListItemMedia>
                <ListItemContent>
                  <ListItemTitle>
                    <bdi>{outcome.name}</bdi>
                  </ListItemTitle>
                  {outcome.status === "failed" && (
                    <ListItemDescription variant="paragraph">
                      {apiCodeMessage(outcome.code) ??
                        t("sharepoint.import.failedReason")}
                    </ListItemDescription>
                  )}
                </ListItemContent>
                <ListItemActions>
                  <ListItemStatus tone={presentation.tone}>
                    {t(presentation.label)}
                  </ListItemStatus>
                </ListItemActions>
              </ListItem>
            );
          })}
        </List>
      </DialogPanel>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.done")}</Button>
      </DialogFooter>
    </>
  );
};
