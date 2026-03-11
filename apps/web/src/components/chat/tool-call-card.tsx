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
    <div className="bg-muted/40 my-1 rounded-md border text-xs">
      <button
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1.5 text-start",
          !canExpand && "cursor-default",
        )}
        onClick={() => canExpand && setExpanded((e) => !e)}
        type="button"
      >
        {isLoading ? (
          <div className="border-foreground/20 border-t-foreground size-3 animate-spin rounded-full border" />
        ) : (
          <Icon className="text-muted-foreground size-3 shrink-0" />
        )}
        <span className="flex-1 truncate font-medium">{label}</span>
        {canExpand && (
          <ChevronDownIcon
            className={cn(
              "text-muted-foreground size-3 shrink-0 transition-transform",
              expanded && "rotate-180",
            )}
          />
        )}
      </button>
      {expanded && hasOutput && (
        <div className="border-t px-2 py-1.5">
          <pre className="text-muted-foreground max-h-40 overflow-auto text-[11px] whitespace-pre-wrap">
            {JSON.stringify(part.output, null, 2)}
          </pre>
        </div>
      )}
      {hasError && "errorText" in part && (
        <div className="text-destructive border-t px-2 py-1.5">
          {String(part.errorText)}
        </div>
      )}
    </div>
  );
};
