import { useRef } from "react";

import { UploadIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  EMPTY_SCREEN_MATTERS_VIDEO,
  EmptyScreen,
} from "@/components/empty-screen";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";

type EmptyStateProps = {
  icon: LucideIcon;
  message: string;
  hint?: string;
  workspaceId?: string;
};

export const EmptyState = ({
  icon: Icon,
  message,
  hint,
  workspaceId,
}: EmptyStateProps) => {
  const t = useTranslations();

  if (workspaceId) {
    return (
      <WorkspaceUploadEmptyScreen
        description={hint ?? t("workspaces.emptyDocuments.description")}
        title={
          message === t("workspaces.noItems") ||
          message === t("workspaces.filesystem.noFilesYet")
            ? t("workspaces.emptyDocuments.title")
            : message
        }
        workspaceId={workspaceId}
      />
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <Icon className="text-muted-foreground size-8" />
        <div>
          <p className="text-muted-foreground text-sm">{message}</p>
          {hint && (
            <p className="text-foreground-strong-muted mt-1 text-xs">{hint}</p>
          )}
        </div>
      </div>
    </div>
  );
};

type WorkspaceUploadEmptyScreenProps = {
  title: string;
  description: string;
  workspaceId: string;
};

const WorkspaceUploadEmptyScreen = ({
  title,
  description,
  workspaceId,
}: WorkspaceUploadEmptyScreenProps) => {
  const tWorkspaces = useTranslations("workspaces");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPending, createFileEntities] = useCreateFileEntities(workspaceId);

  return (
    <>
      <EmptyScreen
        description={description}
        primaryAction={{
          label: tWorkspaces("uploadDocuments"),
          icon: UploadIcon,
          disabled: isPending,
          onClick: () => fileInputRef.current?.click(),
        }}
        title={title}
        video={{
          ...EMPTY_SCREEN_MATTERS_VIDEO,
          title: tWorkspaces("emptyMatters.videoLabel"),
        }}
      />
      <input
        className="sr-only"
        multiple
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          if (files.length > 0) {
            createFileEntities(files);
          }
          e.target.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />
    </>
  );
};
