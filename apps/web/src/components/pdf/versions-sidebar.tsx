import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { openFilePicker } from "@stll/ui/file-picker";
import {
  CheckIcon,
  DownloadIcon,
  FileDiffIcon,
  HistoryIcon,
  PlusIcon,
  Trash2Icon,
} from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "@stll/ui/menu";
import { ScrollArea } from "@stll/ui/scroll-area";
import { useContentDir } from "@stll/ui/use-content-dir";
import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { VersionList, VersionRow } from "@/components/versions/version-list";
import type { VersionDiffSegment } from "@/components/versions/version-list";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { DOCX_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { filesKeys } from "@/lib/files/queries";
import {
  ENTITY_VERSION_UPLOAD_RESULT,
  uploadEntityVersion,
} from "@/lib/files/upload-entity-version";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { toSafeId } from "@/lib/safe-id";
import {
  type EntityVersion as Version,
  entityVersionsKeys,
} from "@/lib/workspaces/queries/entity-versions";

const ERROR_CAPTURE = {
  handleDeleteVersion: {
    fingerprintKey: "VersionsSidebar.handleDeleteVersion:failure",
    scope: {
      type: "handler",
      handlerId: "VersionsSidebar.handleDeleteVersion:failure",
    },
  },
  handleSetLabel: {
    fingerprintKey: "VersionsSidebar.handleSetLabel:failure",
    scope: {
      type: "handler",
      handlerId: "VersionsSidebar.handleSetLabel:failure",
    },
  },
  handleRestore: {
    fingerprintKey: "VersionsSidebar.handleRestore:failure",
    scope: {
      type: "handler",
      handlerId: "VersionsSidebar.handleRestore:failure",
    },
  },
} as const;

export type { EntityVersion as Version } from "@/lib/workspaces/queries/entity-versions";

type VersionsSidebarProps = {
  workspaceId: string;
  entityId: string;
  currentFieldId: string;
  versions: Version[];
  currentVersionId: string | null;
  onSwitchVersion: (fieldId: string, versionId: string) => Promise<void> | void;
  /** Whether an older page exists to load above the current top. */
  hasOlderVersions?: boolean | undefined;
  /** True while an older page is being fetched + prepended. */
  isLoadingOlder?: boolean | undefined;
  /** True after an older-page fetch failed; pauses the auto-trigger so the
   *  sentinel cannot loop the request (the manual button still retries). */
  loadOlderError?: boolean | undefined;
  /** Fetch + prepend the page immediately older than the current top. */
  onLoadOlder?: (() => void | PromiseLike<void>) | undefined;
  /** Open document comparison within the version-history facet. */
  onCompareVersions?: (() => void) | undefined;
  /** Two or more versions exist, but not two DOCX files to compare. */
  compareNeedsDocx?: boolean | undefined;
};

type LabelPreset = {
  key: "draft" | "counterpartyReview" | "final" | "signed";
  color: string;
};

const LABEL_PRESETS: LabelPreset[] = [
  { key: "draft", color: "bg-foreground-disabled" },
  {
    key: "counterpartyReview",
    color: "bg-foreground-strong-muted dark:bg-foreground-strong-muted",
  },
  { key: "final", color: "bg-success dark:bg-success" },
  { key: "signed", color: "bg-warning" },
];

export const VersionsSidebar = ({
  workspaceId,
  entityId,
  currentFieldId,
  versions,
  currentVersionId,
  onSwitchVersion,
  hasOlderVersions = false,
  isLoadingOlder = false,
  loadOlderError = false,
  onLoadOlder,
  onCompareVersions,
  compareNeedsDocx = false,
}: VersionsSidebarProps) => {
  const t = useTranslations();

  const queryClient = useQueryClient();
  const [isUploading, setIsUploading] = useState(false);

  // The viewport is the scrollable element of the Base UI ScrollArea
  // (forwarded via `viewportRef`), which is the IntersectionObserver root.
  const viewportRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const canLoadOlder = hasOlderVersions && onLoadOlder !== undefined;
  const triggerLoadOlder = useLatestCallback(() => {
    detached(onLoadOlder?.(), "versions-sidebar.load-older");
  });

  // Drive the trigger from an end-of-list sentinel: when it scrolls into view
  // (with a buffer) and an older page exists, fetch it. The observer
  // re-arms each render so it tracks the latest `canLoadOlder` /
  // `isLoadingOlder` without firing while a fetch is in flight.
  // `loadOlderError` keeps the observer detached after a failure so it
  // cannot loop the request; the manual button is the only retry path.
  useExternalSyncEffect(() => {
    const root = viewportRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !canLoadOlder || isLoadingOlder || loadOlderError) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry?.isIntersecting) {
          return;
        }
        triggerLoadOlder();
      },
      { root, rootMargin: "0px 0px 240px 0px" },
    );

    observer.observe(target);
    return () => observer.disconnect();
    // Re-arm on paging state AND when the bound load callback changes:
    // its identity changes on entity switch, so this stops the observer
    // from fetching the previous entity's older page into the current
    // list.
  }, [canLoadOlder, isLoadingOlder, loadOlderError, triggerLoadOlder]);

  const invalidateVersions = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
      }),
      // Upload/restore/delete rewrite the entity's current file bytes;
      // without this, open viewers keep the previous version's cached
      // buffer for the rest of the client-wide staleTime window.
      queryClient.invalidateQueries({ queryKey: filesKeys.all() }),
    ]);
  };

  const handleUploadVersion = async (file: File) => {
    setIsUploading(true);
    try {
      const result = await uploadEntityVersion({ workspaceId, entityId, file });
      switch (result.type) {
        case ENTITY_VERSION_UPLOAD_RESULT.cancelled:
          return;
        case ENTITY_VERSION_UPLOAD_RESULT.uploaded:
          await invalidateVersions();
          return;
        default:
          result satisfies never;
          panic(`Unhandled entity version upload: ${String(result)}`);
      }
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteVersion = async (versionId: string) => {
    const deletedVersion = versions.find((v) => v.id === versionId);
    const remaining = versions.filter((v) => v.id !== versionId);
    const switchTarget =
      remaining.find((v) => v.id === currentVersionId) ?? remaining.at(0);

    const requested = await Result.tryPromise(async () =>
      unwrapApiResponse(
        await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .entity({ entityId: toSafeId<"entity">(entityId) })
          .versions({ versionId: toSafeId<"entityVersion">(versionId) })
          .delete({}),
      ),
    );
    if (Result.isError(requested)) {
      getAnalytics().captureError(
        requested.error,
        ERROR_CAPTURE.handleDeleteVersion,
      );
      notifyUserError(requested.error, t("errors.actionFailed"));
      await invalidateVersions();
      return;
    }

    await invalidateVersions();

    if (
      deletedVersion?.file?.fieldId === currentFieldId &&
      switchTarget?.file
    ) {
      await onSwitchVersion(switchTarget.file.fieldId, switchTarget.id);
    }
  };

  const handleSetLabel = async (versionId: string, label: string | null) => {
    const requested = await Result.tryPromise(async () =>
      unwrapApiResponse(
        await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .entity({ entityId: toSafeId<"entity">(entityId) })
          .versions({ versionId: toSafeId<"entityVersion">(versionId) })
          .label.patch({
            label,
          }),
      ),
    );
    if (Result.isError(requested)) {
      getAnalytics().captureError(
        requested.error,
        ERROR_CAPTURE.handleSetLabel,
      );
      notifyUserError(requested.error, t("errors.actionFailed"));
    }

    await invalidateVersions();
  };

  const handleRestore = async (versionId: string) => {
    const requested = await Result.tryPromise(async () =>
      unwrapApiResponse(
        await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .entity({ entityId: toSafeId<"entity">(entityId) })
          .versions({ versionId: toSafeId<"entityVersion">(versionId) })
          .restore.post({}),
      ),
    );
    if (Result.isError(requested)) {
      getAnalytics().captureError(requested.error, ERROR_CAPTURE.handleRestore);
      notifyUserError(requested.error, t("errors.actionFailed"));
    }

    await invalidateVersions();
  };

  const handleDownload = async (fieldId: string) => {
    const response = await api
      .files({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .url({ fieldId: toSafeId<"field">(fieldId) })
      .get({ query: { purpose: "download" } });
    if (!response.error) {
      openIsolatedWindow(response.data.presignedUrl);
    }
  };

  // Diff + AI summary loaders for the shared VersionRow. Only DOCX
  // versions can be diffed; non-DOCX rows get neither control.
  const buildLoadDiff =
    (versionId: string) => async (): Promise<VersionDiffSegment[]> => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .entity({ entityId: toSafeId<"entity">(entityId) })
        .versions({ versionId: toSafeId<"entityVersion">(versionId) })
        .diff.get();
      return unwrapApiResponse(response).segments;
    };

  const buildSummarize =
    (versionId: string) => async (): Promise<string | null> => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .entity({ entityId: toSafeId<"entity">(entityId) })
        .versions({ versionId: toSafeId<"entityVersion">(versionId) })
        .summarize.post({});
      return unwrapApiResponse(response).summary;
    };

  // Newest first, so the current version opens at the top and older pages
  // extend the list downward. The upload sits in the same bottom-row slot as
  // "Extract entity type" on the metadata facet so the two facets share the
  // same footer pattern.
  const orderedVersions = [...versions].toSorted(
    (a, b) => b.versionNumber - a.versionNumber,
  );

  return (
    <div className="flex h-full flex-col">
      {/* Version list */}
      <ScrollArea className="flex-1" viewportRef={viewportRef}>
        <VersionList>
          {orderedVersions.map((version, idx) => {
            const isDocx = version.file?.mimeType === DOCX_MIME;
            return (
              <VersionItem
                key={version.id}
                canDelete={versions.length > 1}
                currentFieldId={currentFieldId}
                currentVersionId={currentVersionId}
                loadDiff={isDocx ? buildLoadDiff(version.id) : null}
                showPhaseDivider={
                  idx > 0 &&
                  version.label !== orderedVersions[idx - 1]?.label &&
                  (version.label !== null ||
                    (orderedVersions[idx - 1]?.label ?? null) !== null)
                }
                summarize={isDocx ? buildSummarize(version.id) : null}
                version={version}
                onDelete={handleDeleteVersion}
                onDownload={(fid) => {
                  detached(handleDownload(fid), "versions-sidebar.download");
                }}
                onRestore={(vid) => {
                  detached(handleRestore(vid), "versions-sidebar.restore");
                }}
                onSetLabel={handleSetLabel}
                onSwitchVersion={onSwitchVersion}
              />
            );
          })}
          {canLoadOlder && (
            <LoadOlderVersions
              isLoadingOlder={isLoadingOlder}
              loadOlderError={loadOlderError}
              onLoadOlder={triggerLoadOlder}
              ref={sentinelRef}
            />
          )}
        </VersionList>
      </ScrollArea>

      {/* Footer row — version operations stay in the history facet.
       *  Each action uses the same quiet toolbar pattern: ghost button,
       *  leading icon, label.
       *  `flex-1` is mandatory; without it the Button base's
       *  `inline-flex shrink-0` keeps the click target at content
       *  width, so hovering the empty right portion of the row
       *  doesn't register. */}
      <div className={cn("flex shrink-0 border-t", TOOLBAR_ROW_HEIGHT)}>
        {compareNeedsDocx && (
          <Button
            className="text-muted-foreground flex h-full min-w-0 flex-1 items-center justify-center gap-2 rounded-none px-3 text-sm"
            disabled
            type="button"
            variant="ghost"
          >
            <FileDiffIcon className="size-4 shrink-0" />
            <span className="truncate">{t("fileDetail.compareDocxOnly")}</span>
          </Button>
        )}
        {onCompareVersions && (
          <Button
            className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-full min-w-0 flex-1 justify-start gap-2 rounded-none border-0 border-e px-3 font-normal before:rounded-none"
            onClick={onCompareVersions}
            type="button"
            variant="ghost"
          >
            <FileDiffIcon className="size-4 shrink-0" />
            <span className="truncate">{t("fileDetail.compare")}</span>
          </Button>
        )}
        <Button
          className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-full min-w-0 flex-1 justify-start gap-2 rounded-none border-0 px-3 font-normal before:rounded-none"
          disabled={isUploading}
          onClick={() => {
            openFilePicker({
              accept: ".docx,.pdf,.doc",
              onPick: ([file]) => {
                detached(
                  handleUploadVersion(file),
                  "versions-sidebar.upload-version",
                );
              },
            });
          }}
          type="button"
          variant="ghost"
        >
          <PlusIcon className="size-4" />
          <span className="truncate">{t("fileDetail.uploadNewVersion")}</span>
        </Button>
      </div>
    </div>
  );
};

// -- Load-older paging affordance --

type LoadOlderVersionsProps = {
  isLoadingOlder: boolean;
  loadOlderError: boolean;
  onLoadOlder: () => void;
  ref: React.Ref<HTMLDivElement>;
};

/**
 * End-of-list paging affordance. The `div` is the IntersectionObserver
 * target that auto-loads when scrolled near; the button is the manual,
 * keyboard-accessible fallback. While a page is in flight it shows a
 * spinner instead so the observer (re-armed only when idle) cannot
 * stack requests; after a failure it surfaces the error and the button
 * stays the only retry path.
 */
const LoadOlderVersions = ({
  isLoadingOlder,
  loadOlderError,
  onLoadOlder,
  ref,
}: LoadOlderVersionsProps) => {
  const t = useTranslations();

  if (isLoadingOlder) {
    return (
      <div className="flex justify-center py-1" ref={ref}>
        <span
          aria-busy="true"
          className="text-muted-foreground flex items-center gap-2 text-xs"
          role="status"
        >
          <Loader className="size-3.5" size="sm" variant="decorative" />
          {t("common.loading")}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1 py-1" ref={ref}>
      {loadOlderError && (
        <span className="text-destructive text-xs">
          {t("common.somethingWentWrong")}
        </span>
      )}
      <Button onClick={onLoadOlder} size="sm" variant="ghost">
        {t("common.loadMore")}
      </Button>
    </div>
  );
};

// -- Version item with context menu --

type VersionItemProps = {
  version: Version;
  currentFieldId: string;
  currentVersionId: string | null;
  showPhaseDivider: boolean;
  canDelete: boolean;
  loadDiff: (() => Promise<VersionDiffSegment[]>) | null;
  summarize: (() => Promise<string | null>) | null;
  onSwitchVersion: (fieldId: string, versionId: string) => Promise<void> | void;
  onDelete: (versionId: string) => Promise<void>;
  onSetLabel: (versionId: string, label: string | null) => Promise<void>;
  onRestore: (versionId: string) => void;
  onDownload: (fieldId: string) => void;
};

const VersionItem = ({
  version,
  showPhaseDivider,
  currentFieldId,
  currentVersionId,
  canDelete,
  loadDiff,
  summarize,
  onSwitchVersion,
  onDelete,
  onSetLabel,
  onRestore,
  onDownload,
}: VersionItemProps) => {
  const t = useTranslations();
  const isSelected = version.file?.fieldId === currentFieldId;
  const isCurrent = version.id === currentVersionId;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [contextAnchor, setContextAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);
  const isContextOpen = contextAnchor !== null;

  // Build translated label → color map for this render
  const labelColorMap = new Map(
    LABEL_PRESETS.map((p) => [t(`fileDetail.labelPresets.${p.key}`), p.color]),
  );
  const labelDotColor =
    version.label !== null
      ? (labelColorMap.get(version.label) ?? DEFAULT_LABEL_COLOR)
      : DEFAULT_LABEL_COLOR;

  const stats =
    version.diffWordsAdded !== null &&
    version.diffWordsRemoved !== null &&
    (version.diffWordsAdded > 0 || version.diffWordsRemoved > 0)
      ? { added: version.diffWordsAdded, removed: version.diffWordsRemoved }
      : null;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    setContextAnchor({
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    });
  };

  return (
    <div key={version.id}>
      {showPhaseDivider && <div className="border-border my-1 border-t" />}
      <VersionRow
        author={version.author}
        diffLabel={
          version.versionNumber === 1 ? t("fileDetail.showText") : undefined
        }
        createdAt={version.createdAt}
        isCurrent={isCurrent}
        isSelected={isSelected}
        isViewing={isSelected && !isCurrent}
        loadDiff={loadDiff}
        meta={
          (version.stamp !== null || version.label !== null) && (
            <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
              {version.stamp !== null && (
                <Tooltip
                  content={t("common.documentReference")}
                  render={
                    <span className="text-muted-foreground text-3xs truncate font-mono" />
                  }
                >
                  <BidiText direction="ltr">{version.stamp}</BidiText>
                </Tooltip>
              )}
              {version.label !== null && (
                <span className="text-accent-foreground text-3xs inline-flex w-fit items-center gap-1.5 truncate font-medium">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      labelDotColor,
                    )}
                  />
                  {version.label}
                </span>
              )}
            </div>
          )
        }
        stats={stats}
        summarize={summarize}
        title={`v${version.versionNumber}`}
        onActivate={() => {
          if (version.file) {
            detached(
              onSwitchVersion(version.file.fieldId, version.id),
              "versions-sidebar.switch-version",
            );
          }
        }}
        onContextMenu={handleContextMenu}
      />

      <Menu
        open={isContextOpen}
        onOpenChange={(o) => {
          if (!o) {
            setContextAnchor(null);
          }
        }}
      >
        <MenuPopup anchor={contextAnchor ?? undefined}>
          {/* Label presets with color dots */}
          {LABEL_PRESETS.map((preset) => {
            const label = t(`fileDetail.labelPresets.${preset.key}`);
            const isActive = version.label === label;
            return (
              <MenuItem
                key={preset.key}
                onClick={() => {
                  detached(
                    onSetLabel(version.id, isActive ? null : label),
                    "versions-sidebar.set-label",
                  );
                }}
              >
                <span
                  className={cn("size-2.5 shrink-0 rounded-full", preset.color)}
                />
                {label}
                {isActive && <CheckIcon className="ms-auto size-3" />}
              </MenuItem>
            );
          })}

          {/* Custom label input — the form action resets the
              uncontrolled input automatically once the mutation
              settles; we just close the menu after the action
              finishes. */}
          <div className="px-2 py-1.5">
            <form
              action={async (formData) => {
                const raw = formData.get("customLabel");
                const value = typeof raw === "string" ? raw.trim() : "";
                if (!value) {
                  return;
                }
                await onSetLabel(version.id, value);
                setContextAnchor(null);
              }}
            >
              <VersionLabelInput placeholder={t("fileDetail.label")} />
            </form>
          </div>

          <MenuSeparator />

          {/* Download */}
          {version.file !== null && (
            <MenuItem
              onClick={() => {
                // SAFETY: guarded by version.file !== null above
                onDownload(version.file?.fieldId ?? "");
              }}
            >
              <DownloadIcon />
              {t("common.download")}
            </MenuItem>
          )}

          {/* Restore */}
          {!isCurrent && (
            <MenuItem onClick={() => onRestore(version.id)}>
              <HistoryIcon />
              {t("fileDetail.makeCurrent")}
            </MenuItem>
          )}

          {/* Delete */}
          {canDelete && (
            <>
              <MenuSeparator />
              <MenuItem
                onClick={() => setDeleteOpen(true)}
                variant="destructive"
              >
                <Trash2Icon />
                {t("fileDetail.deleteVersion")}
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
      {/* Outside the menu so the menu can close under the confirmation. */}
      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("fileDetail.deleteVersion")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("fileDetail.confirmDeleteVersion", {
                version: `v${version.versionNumber}`,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <AlertDialogClose
              render={
                <Button
                  onClick={() => {
                    detached(onDelete(version.id), "versions-sidebar.delete");
                  }}
                  variant="destructive"
                />
              }
            >
              {t("common.delete")}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
};

const DEFAULT_LABEL_COLOR = "bg-foreground-disabled";

// Keys the surrounding menu keeps: Escape closes it and the arrows move
// between items. Every other key, Enter included, stays in the field so the
// menu's typeahead cannot eat the typed label and Enter submits the form.
const MENU_OWNED_KEYS = ["Escape", "ArrowDown", "ArrowUp"] as const;

// Uncontrolled custom-label field (the form action reads it via FormData). It
// is free text in any language, so resolve direction from the typed content
// (empty inherits the UI direction; first character sets LTR vs RTL).
const VersionLabelInput = ({ placeholder }: { placeholder: string }) => {
  const labelDir = useContentDir({
    dir: undefined,
    value: undefined,
    defaultValue: undefined,
  });
  return (
    <input
      autoComplete="off"
      className="border-input bg-background placeholder:text-muted-foreground focus:ring-ring w-full rounded-md border px-2 py-1 text-xs outline-none focus:ring-1"
      dir={labelDir.dir}
      maxLength={128}
      name="customLabel"
      onChange={(event) => labelDir.trackValue(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (!MENU_OWNED_KEYS.some((key) => key === event.key)) {
          event.stopPropagation();
        }
      }}
      placeholder={placeholder}
    />
  );
};
