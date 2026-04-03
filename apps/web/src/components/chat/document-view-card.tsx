/**
 * Renders the result of the displayDocument tool call
 * as a scrollable document card in the chat.
 */

import { FileTextIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import type { DisplayDocumentOutput } from "@/components/chat/chat-ui-tools";

type DocumentViewCardProps = {
  result: DisplayDocumentOutput;
};

const VIEW_LABELS = {
  simple: "chat.documentView.simple",
  original: "chat.documentView.original",
  "tracked-changes": "chat.documentView.trackedChanges",
} as const;

export const DocumentViewCard = ({ result }: DocumentViewCardProps) => {
  const t = useTranslations();

  // SAFETY: view from validated document-view tool output
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  const viewKey = result.view as keyof typeof VIEW_LABELS;
  const viewLabel =
    viewKey in VIEW_LABELS ? t(VIEW_LABELS[viewKey]) : result.view;

  return (
    <div className={cn("bg-muted/30 rounded-lg border", "overflow-hidden")}>
      <div
        className={cn(
          "flex items-center gap-2 border-b",
          "text-muted-foreground px-3 py-2 text-xs",
        )}
      >
        <FileTextIcon className="size-3.5" />
        <span className="font-medium">{result.filename}</span>
        <span className="bg-muted ms-auto rounded px-1.5 py-0.5 text-[10px]">
          {viewLabel}
        </span>
      </div>
      <pre
        className={cn(
          "max-h-64 overflow-auto p-3",
          "text-xs leading-relaxed whitespace-pre-wrap",
          "font-sans",
        )}
      >
        {result.text}
      </pre>
    </div>
  );
};
