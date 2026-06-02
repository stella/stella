import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  DownloadIcon,
  HistoryIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

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
import { cn } from "@stll/ui/lib/utils";

import { UserAvatar } from "@/components/user-avatar";
import { api } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { ClientOperationError, toAPIError } from "@/lib/errors";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
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

const UPLOAD_PUT_TIMEOUT_MS = 5 * 60 * 1000;

export function VersionsSidebar({
  workspaceId,
  entityId,
  currentFieldId,
  versions,
  currentVersionId,
  onSwitchVersion,
  onClearCompare,
  isComparing,
}: VersionsSidebarProps) {
  const t = useTranslations();
  const locale = useLocale();

  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

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
      if (presign.error) {
        throw toAPIError(presign.error);
      }
      const { uploadId, url, headers } = presign.data;

      // 3. PUT to S3.
      const putResponse = await fetch(url, {
        method: "PUT",
        headers,
        body: file,
        signal: AbortSignal.timeout(UPLOAD_PUT_TIMEOUT_MS),
      });
      if (!putResponse.ok) {
        await wsClient({ uploadId })
          .abort.post({})
          .catch(() => undefined);
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
    await api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .entity({ entityId: toSafeId<"entity">(entityId) })
      .versions({ versionId: toSafeId<"entityVersion">(versionId) })
      .label.patch({
        label,
        queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
      });
    await invalidateVersions();
  };

  const handleRestore = async (versionId: string) => {
    await api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .entity({ entityId: toSafeId<"entity">(entityId) })
      .versions({ versionId: toSafeId<"entityVersion">(versionId) })
      .restore.post({
        queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
      });
    await invalidateVersions();
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
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-px p-1">
          {orderedVersions.map((version, idx) => (
            <VersionItem
              key={version.id}
              canDelete={versions.length > 1}
              currentFieldId={currentFieldId}
              currentVersionId={currentVersionId}
              hideDiffStats={isComparing}
              locale={locale}
              prevVersion={orderedVersions[idx - 1]}
              showPhaseDivider={
                idx > 0 &&
                version.label !== orderedVersions[idx - 1]?.label &&
                (version.label !== null ||
                  orderedVersions[idx - 1]?.label !== null)
              }
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
          ))}
        </div>
      </ScrollArea>

      {/* TODO: Restore version comparison controls once the feature is finalized. */}

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

// -- Version item with context menu --

type VersionItemProps = {
  version: Version;
  prevVersion: Version | undefined;
  currentFieldId: string;
  currentVersionId: string | null;
  hideDiffStats: boolean;
  locale: string;
  showPhaseDivider: boolean;
  canDelete: boolean;
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
  locale,
  canDelete,
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

  const hasDiff =
    !hideDiffStats &&
    version.diffWordsAdded !== null &&
    version.diffWordsRemoved !== null &&
    (version.diffWordsAdded > 0 || version.diffWordsRemoved > 0);

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
      <button
        className={cn(
          "relative flex w-full flex-col gap-1.5 rounded-md px-3 py-2 text-start transition-colors",
          // The selected version gets a stronger fill + an accent
          // bar on the leading edge so the active row stays
          // unmistakable even when scrolled. The bar uses a logical
          // start position so RTL keeps it on the leading side.
          isSelected
            ? "bg-accent text-accent-foreground ring-primary/40 ring-1"
            : "hover:bg-muted/50",
        )}
        type="button"
        onClick={() => {
          if (version.file) {
            void onSwitchVersion(version.file.fieldId, version.id);
          }
        }}
        onContextMenu={handleContextMenu}
      >
        {isSelected && (
          <span
            aria-hidden="true"
            className="bg-primary absolute inset-y-1 start-0 w-0.5 rounded-full"
          />
        )}
        {/* Row 1: version number + badges */}
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">v{version.versionNumber}</span>
          {isCurrent && (
            <span className="bg-primary/10 text-primary flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
              <CheckIcon className="size-2.5" />
              {t("fileDetail.current")}
            </span>
          )}
          {isSelected && !isCurrent && (
            <span className="bg-primary text-primary-foreground flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
              {t("fileDetail.viewing")}
            </span>
          )}
          {hasDiff && (
            <span className="ms-auto flex items-center gap-1 text-[10px] tabular-nums">
              <span className="text-success">+{version.diffWordsAdded}</span>
              <span className="text-destructive">
                −{version.diffWordsRemoved}
              </span>
            </span>
          )}
        </div>

        {/* Row 2: label with color dot */}
        {version.label && (
          <span className="text-accent-foreground inline-flex w-fit items-center gap-1.5 truncate text-[10px] font-medium">
            <span
              className={cn("size-2 shrink-0 rounded-full", labelDotColor)}
            />
            {version.label}
          </span>
        )}

        {/* Row 3: author + time */}
        <div className="flex items-center gap-1.5">
          {version.author && (
            <UserAvatar
              className="size-4 shrink-0 text-[8px]"
              image={version.author.image}
              name={version.author.name}
            />
          )}
          <span className="text-muted-foreground truncate text-xs">
            {version.author ? firstName(version.author.name) : ""}
          </span>
          <span
            className="text-muted-foreground shrink-0 text-xs"
            title={formatFullTimestamp(version.createdAt, locale)}
          >
            {formatRelativeTime(version.createdAt, locale)}
          </span>
        </div>
      </button>

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
              <input
                autoComplete="off"
                className="border-input bg-background placeholder:text-muted-foreground focus:ring-ring w-full rounded-md border px-2 py-1 text-xs outline-none focus:ring-1"
                maxLength={128}
                name="customLabel"
                placeholder={t("fileDetail.label")}
              />
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

// -- Utilities --

const firstName = (fullName: string) =>
  fullName.split(/\s+/u).at(0) ?? fullName;

const DEFAULT_LABEL_COLOR = "bg-foreground-disabled";
