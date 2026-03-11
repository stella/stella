import { useRef } from "react";

import { UploadIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

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
}: EmptyStateProps) => (
  <div className="flex flex-1 items-center justify-center p-8">
    <div className="flex flex-col items-center gap-3 text-center">
      <Icon className="text-muted-foreground size-8" />
      <div>
        <p className="text-muted-foreground text-sm">{message}</p>
        {hint && (
          <p className="text-muted-foreground/80 mt-1 text-xs">{hint}</p>
        )}
      </div>
      {workspaceId && <UploadButton workspaceId={workspaceId} />}
    </div>
  </div>
);

const UploadButton = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPending, createFileEntities] = useCreateFileEntities(workspaceId);

  return (
    <>
      <Button
        disabled={isPending}
        onClick={() => fileInputRef.current?.click()}
        size="sm"
        variant="outline"
      >
        <UploadIcon className="size-3.5" />
        {t("common.uploadFiles")}
      </Button>
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
