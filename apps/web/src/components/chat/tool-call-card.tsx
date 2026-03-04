import { useState } from "react";
import { getToolName } from "ai";
import {
  ChevronDownIcon,
  FileTextIcon,
  ListIcon,
  SearchIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

const TOOL_META: Record<string, { icon: typeof SearchIcon; labelKey: string }> =
  {
    searchMatter: {
      icon: SearchIcon,
      labelKey: "chat.tool.searchMatter",
    },
    listEntities: {
      icon: ListIcon,
      labelKey: "chat.tool.listEntities",
    },
    readEntity: {
      icon: FileTextIcon,
      labelKey: "chat.tool.readEntity",
    },
    readContent: {
      icon: FileTextIcon,
      labelKey: "chat.tool.readContent",
    },
  };

export const ToolCallCard = ({
  part,
}: {
  part: Parameters<typeof getToolName>[0];
}) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const name = getToolName(part);
  const meta = TOOL_META[name];
  const Icon = meta?.icon ?? SearchIcon;
  // biome-ignore lint/suspicious/noExplicitAny: i18n key is dynamic
  const label = meta ? t(meta.labelKey as any) : name;

  const isLoading =
    part.state === "input-streaming" || part.state === "input-available";
  const hasOutput = part.state === "output-available";
  const hasError = part.state === "output-error";

  return (
    <div className="my-1 rounded-md border bg-muted/40 text-xs">
      <button
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
        onClick={() => setExpanded((e) => !e)}
        type="button"
      >
        {isLoading ? (
          <div className="size-3 animate-spin rounded-full border border-foreground/20 border-t-foreground" />
        ) : (
          <Icon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate font-medium">{label}</span>
        {hasOutput && (
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
