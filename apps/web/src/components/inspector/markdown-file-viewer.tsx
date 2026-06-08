import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Skeleton } from "@stll/ui/components/skeleton";
import { Textarea } from "@stll/ui/components/textarea";

import { MarkdownPreview } from "@/components/markdown-preview";

export type MarkdownMode = "preview" | "edit";

type MarkdownFileViewerProps = {
  draft: string;
  error: Error | null;
  isLoading: boolean;
  mode: MarkdownMode;
  onDraftChange: (next: string) => void;
  onRetry: () => void;
  text: string;
};

export const MarkdownFileViewer = ({
  draft,
  error,
  isLoading,
  mode,
  onDraftChange,
  onRetry,
  text,
}: MarkdownFileViewerProps) => {
  const t = useTranslations();

  return (
    <div className="bg-background flex size-full min-h-0 flex-col">
      <MarkdownFileBody
        draft={draft}
        error={error}
        isLoading={isLoading}
        mode={mode}
        onDraftChange={onDraftChange}
        onRetry={onRetry}
        retryLabel={t("common.retry")}
        text={text}
      />
    </div>
  );
};

type MarkdownFileBodyProps = {
  draft: string;
  error: Error | null;
  isLoading: boolean;
  mode: MarkdownMode;
  onDraftChange: (next: string) => void;
  onRetry: () => void;
  retryLabel: string;
  text: string;
};

const MarkdownFileBody = ({
  draft,
  error,
  isLoading,
  mode,
  onDraftChange,
  onRetry,
  retryLabel,
  text,
}: MarkdownFileBodyProps) => {
  const t = useTranslations();

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted-foreground max-w-sm text-sm">
          {error.message || t("errors.actionFailed")}
        </p>
        <Button onClick={onRetry} size="xs" variant="secondary">
          {retryLabel}
        </Button>
      </div>
    );
  }

  if (mode === "edit") {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <Textarea
          aria-label={t("common.edit")}
          className="min-h-0 flex-1 font-mono text-xs [&_textarea]:h-full [&_textarea]:resize-none"
          onChange={(event) => onDraftChange(event.currentTarget.value)}
          value={draft}
        />
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <article className="px-4 py-3">
        <MarkdownPreview>{text}</MarkdownPreview>
      </article>
    </ScrollArea>
  );
};
