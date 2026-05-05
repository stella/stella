import { useState } from "react";

import { cn } from "@stll/ui/lib/utils";
import { getToolName } from "ai";
import {
  ChevronDownIcon,
  CodeIcon,
  CircleHelpIcon,
  FileTextIcon,
  LibraryIcon,
  SearchIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { getChatToolTitleKey } from "@/components/chat/chat-ui-tools";

type ToolPart = Parameters<typeof getToolName>[0];

const getToolInput = (part: ToolPart): unknown => {
  if (!("input" in part)) {
    return undefined;
  }

  return part.input;
};

const getRunStellaQuerySource = (
  part: ToolPart,
  toolName: string,
): string | undefined => {
  if (toolName !== "run-stella-query") {
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

const getToolSubtitle = ({
  formatCharacterCount,
  part,
  toolName,
}: {
  formatCharacterCount: (count: number) => string;
  part: ToolPart;
  toolName: string;
}) => {
  switch (toolName) {
    case "run-stella-query": {
      const source = getRunStellaQuerySource(part, toolName);
      return source ? formatCharacterCount(source.length) : null;
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
  "describe-stella-api": CircleHelpIcon,
  "run-stella-query": CodeIcon,
  "load-skill": LibraryIcon,
  "read-skill-resource": FileTextIcon,
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
      (name === "run-stella-query" ||
        name === "load-skill" ||
        name === "read-skill-resource"),
    ),
  );
  const Icon = TOOL_ICONS[name] ?? SearchIcon;
  const label = t(getChatToolTitleKey(name));
  const subtitle = getToolSubtitle({
    formatCharacterCount: (count) =>
      t("chat.toolCall.characterCount", { count }),
    part,
    toolName: name,
  });

  const isLoading =
    part.state === "input-streaming" || part.state === "input-available";
  const hasOutput = part.state === "output-available";
  const hasError = part.state === "output-error";
  const toolInput = getToolInput(part);
  const runStellaQuerySource = getRunStellaQuerySource(part, name);
  const showRunStellaQueryOutput = name === "run-stella-query" && hasOutput;
  const canExpand =
    runStellaQuerySource !== undefined ||
    showRunStellaQueryOutput ||
    (showDetails && toolInput !== undefined) ||
    (showDetails && hasOutput);

  return (
    <div className="bg-muted/40 my-1 rounded-md border text-xs">
      <button
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1.5 text-start",
          !canExpand && "cursor-default",
        )}
        onClick={() => {
          if (canExpand) {
            setExpanded((e) => !e);
          }
        }}
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
        (runStellaQuerySource !== undefined ||
          showRunStellaQueryOutput ||
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
            {runStellaQuerySource !== undefined && (
              <div>
                <div className="text-muted-foreground mb-1 text-[11px] font-medium">
                  {t("chat.toolCall.sourceCode")}
                </div>
                <pre className="bg-background/60 text-foreground max-h-96 overflow-auto rounded border px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
                  {runStellaQuerySource}
                </pre>
              </div>
            )}
            {hasOutput &&
              (showDetails || showRunStellaQueryOutput) &&
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
