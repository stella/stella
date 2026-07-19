import { useLayoutEffect, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  DownloadIcon,
  HistoryIcon,
  Loader2Icon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
} from "@stll/ui/components/menu";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { stellaToast } from "@stll/ui/components/toast";
import { useContentDir } from "@stll/ui/hooks/use-content-dir";
import { cn } from "@stll/ui/lib/utils";

import { VersionList, VersionRow } from "@/components/versions/version-list";
import type { VersionDiffSegment } from "@/components/versions/version-list";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { DOCX_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { toAPIError, unwrapEden } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { fetchWithTimeout } from "@/lib/fetch";
import { toSafeId } from "@/lib/safe-id";
import { entityVersionsKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";

type VersionsSidebarProps = {
  workspaceId: string;
  entityId: string;
  currentFieldId: string;
  versions: Version[];
  currentVersionId: string | null;
  onSwitchVersion: (fieldId: string, versionId: string) => Promise<void> | void;
  onClearCompare: () => void;
  isComparing: boolean;
  /** Whether an older page exists to load above the current top. */
  hasOlderVersions?: boolean | undefined;
  /** True while an older page is being fetched + prepended. */
  isLoadingOlder?: boolean | undefined;
  /** True after an older-page fetch failed; pauses the auto-trigger so the
   *  sentinel cannot loop the request (the manual button still retries). */
  loadOlderError?: boolean | undefined;
  /** Fetch + prepend the page immediately older than the current top. */
  onLoadOlder?: (() => void | PromiseLike<void>) | undefined;
};

export type { Version };

type Version = {
  id: string;
  versionNumber: number;
  stamp: string | null;
  label: string | null;
  description: string | null;
  diffWordsAdded: number | null;
  diffWordsRemoved: number | null;
  createdAt: string;
  author: { id: string; name: string; image: string | null } | null;
  file: {
    fieldId: string;
    propertyId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  } | null;
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

// Stall ceiling, not a target duration: a healthy slow upload of a large
// file can legitimately take several minutes.
const UPLOAD_PUT_TIMEOUT_MS = 30 * 60 * 1000;

export function VersionsSidebar({
  workspaceId,
  entityId,
  currentFieldId,
  versions,
  currentVersionId,
  onSwitchVersion,
  onClearCompare,
  isComparing,
  hasOlderVersions = false,
  isLoadingOlder = false,
  loadOlderError = false,
  onLoadOlder,
}: VersionsSidebarProps) {
  const t = useTranslations();

  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  // The viewport is the scrollable element of the Base UI ScrollArea
  // (forwarded via `viewportRef`); it is both the IntersectionObserver
  // root and the element whose scrollTop we adjust to anchor a prepend.
  const viewportRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const canLoadOlder = hasOlderVersions && onLoadOlder !== undefined;
  // The list renders oldest → newest, so loading an older page adds rows at
  // the TOP. `versions` is kept newest-first, so the displayed-top is the
  // OLDEST version (min versionNumber); track its id to detect a genuine
  // older-page load in the layout effect below (vs. a bottom-append upload
  // or an entity switch).
  let topVersionId: string | null = null;
  let oldestVersionNumber = Number.POSITIVE_INFINITY;
  let newestVersionId: string | null = null;
  let newestVersionNumber = Number.NEGATIVE_INFINITY;
  for (const version of versions) {
    if (version.versionNumber < oldestVersionNumber) {
      oldestVersionNumber = version.versionNumber;
      topVersionId = version.id;
    }
    if (version.versionNumber > newestVersionNumber) {
      newestVersionNumber = version.versionNumber;
      newestVersionId = version.id;
    }
  }
  const prevTopVersionIdRef = useRef(topVersionId);
  // scrollHeight captured the instant a load-older request fires,
  // before the prepend grows the container above the viewport. Reset
  // to null once consumed so only a real prepend restores scroll.
  const anchorScrollHeightRef = useRef<number | null>(null);
  // Newest (bottom) version id last positioned at, so the scroll-to-bottom
  // below re-runs on a re-seed (entity switch or a new upload/restore changes
  // the newest id) but not on an older-page append (newest id unchanged).
  const prevNewestVersionIdRef = useRef<string | null>(null);

  const triggerLoadOlder = () => {
    const container = viewportRef.current;
    if (container) {
      anchorScrollHeightRef.current = container.scrollHeight;
    }
    void onLoadOlder?.();
  };

  // Drive the trigger from a top sentinel: when it scrolls into view
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
        const entry = entries.at(0);
        if (!entry?.isIntersecting) {
          return;
        }
        triggerLoadOlder();
      },
      { root, rootMargin: "240px 0px 0px 0px" },
    );

    observer.observe(target);
    return () => observer.disconnect();
    // Re-arm on paging state AND when the bound load callback changes:
    // its identity changes on entity switch, so this stops the observer
    // from fetching the previous entity's older page into the current
    // list.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- triggerLoadOlder is a stable closure over refs; onLoadOlder tracks the active entity
  }, [canLoadOlder, isLoadingOlder, loadOlderError, onLoadOlder]);

  // Scroll anchoring: loading an older page changes the displayed-top
  // (oldest) version id and grows scrollHeight above the viewport. Restore the
  // previous offset before paint so the version under the user's eye stays
  // put. Bottom-appends (uploads) keep the oldest id and skip this; an entity
  // switch changes the id too but has no captured anchor, so it is also
  // skipped.
  useLayoutEffect(() => {
    const previousTopId = prevTopVersionIdRef.current;
    prevTopVersionIdRef.current = topVersionId;
    const previousScrollHeight = anchorScrollHeightRef.current;
    anchorScrollHeightRef.current = null;
    if (previousTopId === topVersionId || previousScrollHeight === null) {
      return;
    }
    const container = viewportRef.current;
    if (!container) {
      return;
    }
    container.scrollTop += container.scrollHeight - previousScrollHeight;
  }, [topVersionId]);

  // Open the list at the bottom (newest) whenever it is (re-)seeded: on first
  // load and on every entity switch or upload/restore the newest id changes.
  // The list is chronological (oldest at the top, just below the load-older
  // sentinel), so without this the viewport starts at the top with the sentinel
  // on screen and the IntersectionObserver pages the whole history on open.
  // Keying on the newest id (not a one-shot flag) re-positions a newly selected
  // entity's list too; an older-page append leaves the newest id unchanged and
  // is handled by the anchoring effect above so the scroll position is kept.
  useLayoutEffect(() => {
    if (prevNewestVersionIdRef.current === newestVersionId) {
      return;
    }
    prevNewestVersionIdRef.current = newestVersionId;
    const container = viewportRef.current;
    if (!container || newestVersionId === null) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [newestVersionId]);

  const invalidateVersions = async () => {
    await queryClient.invalidateQueries({
      queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
    });
  };

  const handleUploadVersion = async (file: File) => {
    setIsUploading(true);
    try {
      // 1. SHA-256 of file bytes.
      const fileBuffer = await file.arrayBuffer();
      const sha256Buffer = await crypto.subtle.digest("SHA-256", fileBuffer);
      const sha256Hex = Array.from(new Uint8Array(sha256Buffer))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

      // 2. Presign.
      const wsClient = api.uploads({
        workspaceId: toSafeId<"workspace">(workspaceId),
      });
      const presign = await wsClient.presign.post({
        purpose: "entity_version",
        entityId: toSafeId<"entity">(entityId),
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        sha256Hex,
      });
      const { uploadId, url, headers } = unwrapEden(presign);

      // 3. PUT to S3.
      const putResponse = await fetchWithTimeout(url, {
        method: "PUT",
        headers,
        body: file,
        timeoutMs: UPLOAD_PUT_TIMEOUT_MS,
      });
      if (!putResponse.ok) {
        // Best-effort: the bucket lifecycle rule and daily prune already
        // reclaim the tmp object and row, so a failed abort here is not
        // fatal. We swallow errors to avoid masking the original S3
        // rejection with a follow-up rejection.
        try {
          // SAFETY: best-effort abort; the bucket lifecycle rule and daily
          // prune already reclaim the tmp object and row, so a failed abort
          // here is not fatal and has no user-facing outcome.
          // eslint-disable-next-line require-eden-error-check/require-eden-error-check
          await wsClient({ uploadId }).abort.post({});
        } catch {
          // Intentionally swallowed; see comment above.
        }
        throw new ClientOperationError({
          action: "upload-version-to-s3",
          message: `S3 rejected upload (${putResponse.status})`,
        });
      }

      // 4. Finalize.
      const finalize = await wsClient({ uploadId }).finalize.post({
        queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
      });
      if (finalize.error) {
        throw toAPIError(finalize.error);
      }

      await invalidateVersions();
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteVersion = async (versionId: string) => {
    const deletedVersion = versions.find((v) => v.id === versionId);
    const remaining = versions.filter((v) => v.id !== versionId);
    const switchTarget =
      remaining.find((v) => v.id === currentVersionId) ?? remaining.at(0);

    try {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .entity({ entityId: toSafeId<"entity">(entityId) })
        .versions({ versionId: toSafeId<"entityVersion">(versionId) })
        .delete({
          queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    } catch {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      await invalidateVersions();
      return;
    }

    onClearCompare();
    await invalidateVersions();

    if (
      deletedVersion?.file?.fieldId === currentFieldId &&
      switchTarget?.file
    ) {
      await onSwitchVersion(switchTarget.file.fieldId, switchTarget.id);
    }
  };

  const handleSetLabel = async (versionId: string, label: string | null) => {
    try {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .entity({ entityId: toSafeId<"entity">(entityId) })
        .versions({ versionId: toSafeId<"entityVersion">(versionId) })
        .label.patch({
          label,
          queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    } catch {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    } finally {
      await invalidateVersions();
    }
  };

  const handleRestore = async (versionId: string) => {
    try {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .entity({ entityId: toSafeId<"entity">(entityId) })
        .versions({ versionId: toSafeId<"entityVersion">(versionId) })
        .restore.post({
          queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    } catch {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    } finally {
      await invalidateVersions();
    }
  };

  const handleDownload = async (fieldId: string) => {
    const response = await api
      .files({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .url({ fieldId: toSafeId<"field">(fieldId) })
      .get({ query: { purpose: "download" } });
    if (!response.error) {
      window.open(response.data.presignedUrl, "_blank");
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
      return unwrapEden(response).segments;
    };

  const buildSummarize =
    (versionId: string) => async (): Promise<string | null> => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .entity({ entityId: toSafeId<"entity">(entityId) })
        .versions({ versionId: toSafeId<"entityVersion">(versionId) })
        .summarize.post({});
      return unwrapEden(response).summary;
    };

  // Render oldest → newest top-to-bottom so the timeline reads
  // naturally (v1 at the top, latest at the bottom). The upload
  // sits in the same bottom-row slot as "Extract entity type" on
  // the metadata facet so the two facets share the same footer
  // pattern.
  const orderedVersions = [...versions].toSorted(
    (a, b) => a.versionNumber - b.versionNumber,
  );

  return (
    <div className="flex h-full flex-col">
      <input
        ref={fileInputRef}
        accept=".docx,.pdf,.doc"
        className="hidden"
        type="file"
        onChange={(e) => {
          const file = e.target.files?.item(0);
          if (file) {
            void handleUploadVersion(file);
          }
          e.target.value = "";
        }}
      />

      {/* Version list */}
      <ScrollArea className="flex-1" viewportRef={viewportRef}>
        <VersionList>
          {canLoadOlder && (
            <LoadOlderVersions
              isLoadingOlder={isLoadingOlder}
              loadOlderError={loadOlderError}
              onLoadOlder={triggerLoadOlder}
              ref={sentinelRef}
            />
          )}
          {orderedVersions.map((version, idx) => {
            const isDocx = version.file?.mimeType === DOCX_MIME;
            return (
              <VersionItem
                key={version.id}
                canDelete={versions.length > 1}
                currentFieldId={currentFieldId}
                currentVersionId={currentVersionId}
                hideDiffStats={isComparing}
                loadDiff={isDocx ? buildLoadDiff(version.id) : null}
                showPhaseDivider={
                  idx > 0 &&
                  version.label !== orderedVersions[idx - 1]?.label &&
                  (version.label !== null ||
                    orderedVersions[idx - 1]?.label !== null)
                }
                summarize={isDocx ? buildSummarize(version.id) : null}
                version={version}
                onDelete={handleDeleteVersion}
                onDownload={(fid) => {
                  void handleDownload(fid);
                }}
                onRestore={(vid) => {
                  void handleRestore(vid);
                }}
                onSetLabel={handleSetLabel}
                onSwitchVersion={onSwitchVersion}
              />
            );
          })}
        </VersionList>
      </ScrollArea>

      {/* Restore version comparison controls once the feature is finalized. */}

      {/* Footer row — mirrors the Metadata facet's "Extract
       *  entity type" trigger so both facets share one bottom-row
       *  pattern: full-width ghost button, leading icon, label.
       *  `flex-1` is mandatory; without it the Button base's
       *  `inline-flex shrink-0` keeps the click target at content
       *  width, so hovering the empty right portion of the row
       *  doesn't register. */}
      <div className={cn("flex shrink-0 border-t", TOOLBAR_ROW_HEIGHT)}>
        <Button
          className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-full w-full flex-1 justify-start gap-2 rounded-none border-0 px-3 font-normal before:rounded-none"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
          type="button"
          variant="ghost"
        >
          <PlusIcon className="size-4" />
          <span className="truncate">{t("fileDetail.uploadNewVersion")}</span>
        </Button>
      </div>
    </div>
  );
}

// -- Load-older paging affordance --

type LoadOlderVersionsProps = {
  isLoadingOlder: boolean;
  loadOlderError: boolean;
  onLoadOlder: () => void;
  ref: React.Ref<HTMLDivElement>;
};

/**
 * Top-of-list paging affordance. The `div` is the IntersectionObserver
 * target that auto-loads when scrolled near; the button is the manual,
 * keyboard-accessible fallback. While a page is in flight it shows a
 * spinner instead so the observer (re-armed only when idle) cannot
 * stack requests; after a failure it surfaces the error and the button
 * stays the only retry path.
 */
function LoadOlderVersions({
  isLoadingOlder,
  loadOlderError,
  onLoadOlder,
  ref,
}: LoadOlderVersionsProps) {
  const t = useTranslations();

  if (isLoadingOlder) {
    return (
      <div className="flex justify-center py-1" ref={ref}>
        <span className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
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
}

// -- Version item with context menu --

type VersionItemProps = {
  version: Version;
  currentFieldId: string;
  currentVersionId: string | null;
  hideDiffStats: boolean;
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

function VersionItem({
  version,
  showPhaseDivider,
  currentFieldId,
  currentVersionId,
  hideDiffStats,
  canDelete,
  loadDiff,
  summarize,
  onSwitchVersion,
  onDelete,
  onSetLabel,
  onRestore,
  onDownload,
}: VersionItemProps) {
  const t = useTranslations();
  const isSelected = version.file?.fieldId === currentFieldId;
  const isCurrent = version.id === currentVersionId;
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
    !hideDiffStats &&
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
        createdAt={version.createdAt}
        isCurrent={isCurrent}
        isSelected={isSelected}
        isViewing={isSelected && !isCurrent}
        loadDiff={loadDiff}
        meta={
          version.label && (
            <span className="text-accent-foreground inline-flex w-fit items-center gap-1.5 truncate text-[10px] font-medium">
              <span
                className={cn("size-2 shrink-0 rounded-full", labelDotColor)}
              />
              {version.label}
            </span>
          )
        }
        stats={stats}
        summarize={summarize}
        title={`v${version.versionNumber}`}
        onActivate={() => {
          if (version.file) {
            void onSwitchVersion(version.file.fieldId, version.id);
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
                  void onSetLabel(version.id, isActive ? null : label);
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
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <MenuItem closeOnClick={false} variant="destructive" />
                  }
                >
                  <Trash2Icon />
                  {t("fileDetail.deleteVersion")}
                </AlertDialogTrigger>
                <AlertDialogPopup>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("fileDetail.deleteVersion")}
                    </AlertDialogTitle>
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
                            void onDelete(version.id);
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
            </>
          )}
        </MenuPopup>
      </Menu>
    </div>
  );
}

const DEFAULT_LABEL_COLOR = "bg-foreground-disabled";

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
      placeholder={placeholder}
    />
  );
};
