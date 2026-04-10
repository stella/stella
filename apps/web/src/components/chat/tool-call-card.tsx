import { useState } from "react";

import { getToolName } from "ai";
import {
  ChevronDownIcon,
  CircleHelpIcon,
  FileTextIcon,
  LandmarkIcon,
  LayoutTemplateIcon,
  ListIcon,
  SearchIcon,
  UserIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

const TOOL_ICONS: Record<string, typeof SearchIcon> = {
  "ask-user": CircleHelpIcon,
  "read-clause": FileTextIcon,
  "list-templates": LayoutTemplateIcon,
  "read-contact": UserIcon,
  "read-content-across-matters": FileTextIcon,
  "search-across-matters": SearchIcon,
  "search-matter": SearchIcon,
  "list-entities": ListIcon,
  "read-entity": FileTextIcon,
  "read-content": FileTextIcon,
  "search-content": SearchIcon,
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
    "ask-user": t("chat.tool.ask-user"),
    "list-templates": t("chat.tool.list-templates"),
    "read-clause": t("chat.tool.read-clause"),
    "read-contact": t("chat.tool.read-contact"),
    "read-content-across-matters": t("chat.tool.read-content-across-matters"),
    "search-across-matters": t("chat.tool.search-across-matters"),
    "search-matter": t("chat.tool.search-matter"),
    "list-entities": t("chat.tool.list-entities"),
    "read-entity": t("chat.tool.read-entity"),
    "read-content": t("chat.tool.read-content"),
    "search-content": t("chat.tool.search-content"),
    searchCaseLaw: t("chat.tool.searchCaseLaw"),
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
