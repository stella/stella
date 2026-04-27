import { useState } from "react";

import { getToolName } from "ai";
import {
  ChevronDownIcon,
  CodeIcon,
  CircleHelpIcon,
  FileTextIcon,
  LandmarkIcon,
  LayoutTemplateIcon,
  SearchIcon,
  UserIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

const getExecuteTypescriptSource = (
  part: Parameters<typeof getToolName>[0],
  toolName: string,
): string | undefined => {
  if (toolName !== "execute-typescript") {
    return undefined;
  }
  if (!("input" in part)) {
    return undefined;
  }
  const { input } = part;
  if (input === undefined || input === null || typeof input !== "object") {
    return undefined;
  }
  if (!("code" in input)) {
    return undefined;
  }
  const code = (input as { code: unknown }).code;
  if (typeof code !== "string") {
    return undefined;
  }

  return code;
};

const TOOL_ICONS: Record<string, typeof SearchIcon> = {
  "ask-user": CircleHelpIcon,
  "describe-stella-function": CircleHelpIcon,
  "execute-typescript": CodeIcon,
  "read-clause": FileTextIcon,
  "list-templates": LayoutTemplateIcon,
  "read-contact": UserIcon,
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
    "describe-stella-function": "Inspecting stella function",
    "execute-typescript": "Running TypeScript",
    "list-templates": t("chat.tool.list-templates"),
    "read-clause": t("chat.tool.read-clause"),
    "read-contact": t("chat.tool.read-contact"),
    searchCaseLaw: t("chat.tool.searchCaseLaw"),
  };
  const label = toolLabels[name] ?? name;

  const isLoading =
    part.state === "input-streaming" || part.state === "input-available";
  const hasOutput = part.state === "output-available";
  const hasError = part.state === "output-error";
  const executeTsSource = getExecuteTypescriptSource(part, name);
  const showExecuteTsOutput = name === "execute-typescript" && hasOutput;
  const canExpand =
    executeTsSource !== undefined ||
    showExecuteTsOutput ||
    (showDetails && hasOutput);

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
      {expanded &&
        (executeTsSource !== undefined ||
          showExecuteTsOutput ||
          (showDetails && hasOutput)) && (
          <div className="space-y-2 border-t px-2 py-1.5">
            {executeTsSource !== undefined && (
              <div>
                <div className="text-muted-foreground mb-1 text-[11px] font-medium">
                  {t("chat.toolCall.sourceCode")}
                </div>
                <pre className="bg-background/60 text-foreground max-h-96 overflow-auto rounded border px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
                  {executeTsSource}
                </pre>
              </div>
            )}
            {hasOutput &&
              (showDetails || showExecuteTsOutput) &&
              "output" in part && (
                <div>
                  <div className="text-muted-foreground mb-1 text-[11px] font-medium">
                    {t("chat.toolCall.output")}
                  </div>
                  <pre className="text-muted-foreground max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
                    {JSON.stringify(part.output, null, 2)}
                  </pre>
                </div>
              )}
          </div>
        )}
      {hasError && "errorText" in part && (
        <div className="text-destructive border-t px-2 py-1.5">
          {part.errorText}
        </div>
      )}
    </div>
  );
};
