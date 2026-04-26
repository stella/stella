import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  DownloadIcon,
  GitCompareArrowsIcon,
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
} from "@stella/ui/components/alert-dialog";
import { Button } from "@stella/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
} from "@stella/ui/components/menu";
import { ScrollArea } from "@stella/ui/components/scroll-area";
import { cn } from "@stella/ui/lib/utils";

import { UserAvatar } from "@/components/user-avatar";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import { entityVersionsKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";

type VersionsSidebarProps = {
  workspaceId: string;
  entityId: string;
  currentFieldId: string;
  versions: Version[];
  currentVersionId: string | null;
  onSwitchVersion: (fieldId: string, versionId: string) => void;
  onCompare: (baseVersionId: string, targetVersionId: string) => void;
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
  { key: "draft", color: "bg-muted-foreground/40" },
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  { key: "counterpartyReview", color: "bg-blue-500 dark:bg-blue-400" },
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  { key: "final", color: "bg-green-500 dark:bg-green-400" },
  { key: "signed", color: "bg-amber-500" },
];

export function VersionsSidebar({
  workspaceId,
  entityId,
  currentFieldId,
  versions,
  currentVersionId,
  onSwitchVersion,
  onCompare,
  onClearCompare,
  isComparing,
}: VersionsSidebarProps) {
  const t = useTranslations();
  const locale = useLocale();

  const selectedVersion = versions.find(
    (v) => v.file?.fieldId === currentFieldId,
  );
  const olderVersions = selectedVersion
    ? versions.filter(
        (v) =>
          v.versionNumber < selectedVersion.versionNumber && v.file !== null,
      )
    : [];

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
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["upload-version"].post({
          entityId: toSafeId<"entity">(entityId),
          file,
          queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
        });

      if (response.error) {
        throw toAPIError(response.error);
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
      onSwitchVersion(switchTarget.file.fieldId, switchTarget.id);
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

  return (
    <div className="flex h-full flex-col">
      {/* Header + upload */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {t("fileDetail.versionHistory")}
        </h3>
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
        <Button
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
          size="xs"
          variant="ghost"
        >
          <PlusIcon className="size-3" />
        </Button>
      </div>

      {/* Version list */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-px p-1">
          {versions.map((version, idx) => (
            <VersionItem
              key={version.id}
              canDelete={versions.length > 1}
              currentFieldId={currentFieldId}
              currentVersionId={currentVersionId}
              hideDiffStats={isComparing}
              locale={locale}
              prevVersion={versions[idx - 1]}
              showPhaseDivider={
                idx > 0 &&
                version.label !== versions[idx - 1]?.label &&
                (version.label !== null || versions[idx - 1]?.label !== null)
              }
              version={version}
              onDelete={handleDeleteVersion}
              onDownload={(fid) => {
                void handleDownload(fid);
              }}
              onRestore={(vid) => {
                void handleRestore(vid);
              }}
              onSetLabel={(vid, label) => {
                void handleSetLabel(vid, label);
              }}
              onSwitchVersion={onSwitchVersion}
            />
          ))}
        </div>
      </ScrollArea>

      {/* Compare buttons */}
      {olderVersions.length > 0 && selectedVersion && (
        <ScrollArea className="max-h-32 shrink-0 border-t">
          <div className="flex flex-col gap-px p-1">
            {olderVersions.map((older) => (
              <button
                key={older.id}
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1.5 rounded-md px-3 py-1.5 text-start text-xs transition-colors"
                disabled={isComparing}
                type="button"
                onClick={() => onCompare(older.id, selectedVersion.id)}
              >
                <GitCompareArrowsIcon className="size-3 shrink-0" />
                {t("fileDetail.changesSince", {
                  version: `v${older.versionNumber}`,
                })}
              </button>
            ))}
          </div>
        </ScrollArea>
      )}
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
  onSwitchVersion: (fieldId: string, versionId: string) => void;
  onDelete: (versionId: string) => Promise<void>;
  onSetLabel: (versionId: string, label: string | null) => void;
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
  const [contextOpen, setContextOpen] = useState(false);
  const [contextAnchor, setContextAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

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
    setContextOpen(true);
  };

  return (
    <div key={version.id}>
      {showPhaseDivider && <div className="border-border my-1 border-t" />}
      <button
        className={cn(
          "flex w-full flex-col gap-1.5 rounded-md px-3 py-2 text-start transition-colors",
          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted/50",
        )}
        type="button"
        onClick={() => {
          if (version.file) {
            onSwitchVersion(version.file.fieldId, version.id);
          }
        }}
        onContextMenu={handleContextMenu}
      >
        {/* Row 1: version number + badges */}
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">v{version.versionNumber}</span>
          {isCurrent && (
            <span className="bg-primary/10 text-primary flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
              <CheckIcon className="size-2.5" />
              {t("fileDetail.current")}
            </span>
          )}
          {hasDiff && (
            <span className="ms-auto flex items-center gap-1 text-[10px] tabular-nums">
              <span className="text-green-600">+{version.diffWordsAdded}</span>
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
          <span className="text-muted-foreground shrink-0 text-xs">
            {formatRelativeTime(version.createdAt, locale)}
          </span>
        </div>
      </button>

      <Menu
        open={contextOpen}
        onOpenChange={(o) => {
          setContextOpen(o);
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
                onClick={() => onSetLabel(version.id, isActive ? null : label)}
              >
                <span
                  className={cn("size-2.5 shrink-0 rounded-full", preset.color)}
                />
                {label}
                {isActive && <CheckIcon className="ms-auto size-3" />}
              </MenuItem>
            );
          })}

          {/* Custom label input */}
          <div className="px-2 py-1.5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                const raw = form.get("customLabel");
                const value = typeof raw === "string" ? raw.trim() : "";
                if (value) {
                  onSetLabel(version.id, value);
                  e.currentTarget.reset();
                  setContextOpen(false);
                }
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

const firstName = (fullName: string) => fullName.split(/\s+/).at(0) ?? fullName;

const DEFAULT_LABEL_COLOR = "bg-muted-foreground/40";
