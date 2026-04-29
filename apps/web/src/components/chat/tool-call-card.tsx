import { useState } from "react";

import { getToolName } from "ai";
import {
  ChevronDownIcon,
  CodeIcon,
  CircleHelpIcon,
  FileTextIcon,
  LandmarkIcon,
  LayoutTemplateIcon,
  LibraryIcon,
  SearchIcon,
  UserIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

type ToolPart = Parameters<typeof getToolName>[0];

const getToolInput = (part: ToolPart): unknown => {
  if (!("input" in part)) {
    return undefined;
  }

  return part.input;
};

const getExecuteTypescriptSource = (
  part: ToolPart,
  toolName: string,
): string | undefined => {
  if (toolName !== "execute-typescript") {
    return undefined;
  }
  const input = getToolInput(part);
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

const getStringInputValue = ({
  key,
  part,
}: {
  key: string;
  part: ToolPart;
}): string | undefined => {
  const input = getToolInput(part);
  if (input === undefined || input === null || typeof input !== "object") {
    return undefined;
  }
  if (!(key in input)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  const value: unknown = descriptor?.value;
  return typeof value === "string" ? value : undefined;
};

const getToolSubtitle = (part: ToolPart, toolName: string) => {
  switch (toolName) {
    case "execute-typescript": {
      const source = getExecuteTypescriptSource(part, toolName);
      return source ? `${source.length.toLocaleString()} chars` : null;
    }
    case "load-skill":
      return getStringInputValue({ key: "skillName", part }) ?? null;
    case "read-skill-resource": {
      const skillName = getStringInputValue({ key: "skillName", part });
      const resourcePath = getStringInputValue({ key: "path", part });
      if (!skillName || !resourcePath) {
        return null;
      }

      return `${skillName}: ${resourcePath}`;
    }
    default:
      return null;
  }
};

const TOOL_ICONS: Record<string, typeof SearchIcon> = {
  "ask-user": CircleHelpIcon,
  "describe-stella-function": CircleHelpIcon,
  "execute-typescript": CodeIcon,
  "load-skill": LibraryIcon,
  "read-clause": FileTextIcon,
  "read-skill-resource": FileTextIcon,
  "list-templates": LayoutTemplateIcon,
  "read-contact": UserIcon,
  searchCaseLaw: LandmarkIcon,
};

export const ToolCallCard = ({
  part,
  showDetails,
}: {
  part: ToolPart;
  /** Show expandable raw output (dev mode). */
  showDetails?: boolean;
}) => {
  const t = useTranslations();
  const name = getToolName(part);
  const [expanded, setExpanded] = useState(() =>
    Boolean(
      showDetails &&
      (name === "execute-typescript" ||
        name === "load-skill" ||
        name === "read-skill-resource"),
    ),
  );
  const Icon = TOOL_ICONS[name] ?? SearchIcon;
  const toolLabels: Record<string, string> = {
    "ask-user": t("chat.tool.ask-user"),
    "describe-stella-function": t("chat.tool.describe-stella-function"),
    "execute-typescript": t("chat.tool.execute-typescript"),
    "load-skill": t("chat.tool.load-skill"),
    "list-templates": t("chat.tool.list-templates"),
    "read-clause": t("chat.tool.read-clause"),
    "read-contact": t("chat.tool.read-contact"),
    "read-skill-resource": t("chat.tool.read-skill-resource"),
    searchCaseLaw: t("chat.tool.searchCaseLaw"),
  };
  const label = toolLabels[name] ?? name;
  const subtitle = getToolSubtitle(part, name);

  const isLoading =
    part.state === "input-streaming" || part.state === "input-available";
  const hasOutput = part.state === "output-available";
  const hasError = part.state === "output-error";
  const toolInput = getToolInput(part);
  const executeTsSource = getExecuteTypescriptSource(part, name);
  const showExecuteTsOutput = name === "execute-typescript" && hasOutput;
  const canExpand =
    executeTsSource !== undefined ||
    showExecuteTsOutput ||
    (showDetails && toolInput !== undefined) ||
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
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{label}</span>
          {subtitle && (
            <span className="text-muted-foreground block truncate">
              {subtitle}
            </span>
          )}
        </span>
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
          (showDetails && toolInput !== undefined) ||
          (showDetails && hasOutput)) && (
          <div className="space-y-2 border-t px-2 py-1.5">
            {showDetails && toolInput !== undefined && (
              <div>
                <div className="text-muted-foreground mb-1 text-[11px] font-medium">
                  {t("chat.toolCall.input")}
                </div>
                <pre className="text-muted-foreground max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
                  {JSON.stringify(toolInput, null, 2)}
                </pre>
              </div>
            )}
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
