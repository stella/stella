import { useState } from "react";
import { getToolName } from "ai";
import {
  ChevronDownIcon,
  FileTextIcon,
  LandmarkIcon,
  ListIcon,
  SearchIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

const TOOL_ICONS: Record<string, typeof SearchIcon> = {
  searchMatter: SearchIcon,
  listEntities: ListIcon,
  readEntity: FileTextIcon,
  readContent: FileTextIcon,
  searchCaseLaw: LandmarkIcon,
};

export const ToolCallCard = ({
  part,
  showDetails,
}: {
  part: Parameters<typeof getToolName>[0];
  /** Show expandable raw output (dev mode). */
  showDetails?: boolean;
}) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const name = getToolName(part);
  const Icon = TOOL_ICONS[name] ?? SearchIcon;
  const toolLabels: Record<string, string> = {
    searchMatter: t("chat.tool.searchMatter"),
    listEntities: t("chat.tool.listEntities"),
    readEntity: t("chat.tool.readEntity"),
    readContent: t("chat.tool.readContent"),
    searchCaseLaw: t("chat.tool.searchCaseLaw"),
    displayDocument: t("chat.tool.displayDocument"),
  };
  const label = toolLabels[name] ?? name;

  const isLoading =
    part.state === "input-streaming" || part.state === "input-available";
  const hasOutput = part.state === "output-available";
  const hasError = part.state === "output-error";
  const canExpand = showDetails && hasOutput;

  return (
    <div className="my-1 rounded-md border bg-muted/40 text-xs">
      <button
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1.5 text-left",
          !canExpand && "cursor-default",
        )}
        onClick={() => canExpand && setExpanded((e) => !e)}
        type="button"
      >
        {isLoading ? (
          <div className="size-3 animate-spin rounded-full border border-foreground/20 border-t-foreground" />
        ) : (
          <Icon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate font-medium">{label}</span>
        {canExpand && (
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        )}
      </button>
      {expanded && hasOutput && (
        <div className="border-t px-2 py-1.5">
          <pre className="max-h-40 overflow-auto text-[11px] whitespace-pre-wrap text-muted-foreground">
            {JSON.stringify(part.output, null, 2)}
          </pre>
        </div>
      )}
      {hasError && "errorText" in part && (
        <div className="border-t px-2 py-1.5 text-destructive">
          {String(part.errorText)}
        </div>
      )}
    </div>
  );
};
