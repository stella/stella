import { useState } from "react";

import { cn } from "@stll/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { getToolName } from "ai";
import {
  ChevronDownIcon,
  CodeIcon,
  CircleHelpIcon,
  FileTextIcon,
  LibraryIcon,
  SearchIcon,
  UserIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  getChatToolTitleKey,
  isRunningToolPart,
} from "@/components/chat/chat-ui-tools";
import { sanitizeHref } from "@/lib/sanitize-href";
import { mcpConnectorsOptions } from "@/routes/_protected.knowledge/-queries";

type ToolPart = Parameters<typeof getToolName>[0];

const getToolInput = (part: ToolPart): unknown => {
  if (!("input" in part)) {
    return undefined;
  }

  return part.input;
};

const CODE_TOOL_NAMES = new Set(["execute-typescript", "run-stella-query"]);

const getCodeToolSource = (
  part: ToolPart,
  toolName: string,
): string | undefined => {
  if (!CODE_TOOL_NAMES.has(toolName)) {
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
    case "execute-typescript":
    case "run-stella-query": {
      const source = getCodeToolSource(part, toolName);
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
      return (
        getStringInputValue({ key: "query", part }) ??
        getStringInputValue({ key: "reference", part }) ??
        getStringInputValue({ key: "ecli", part }) ??
        getStringInputValue({ key: "ico", part }) ??
        getStringInputValue({ key: "name", part }) ??
        null
      );
  }
};

type McpToolInfo = {
  connectorSlug: string;
  label: string;
};

const getMcpToolInfo = (toolName: string): McpToolInfo | null => {
  if (!toolName.startsWith("mcp__")) {
    return null;
  }

  const [, connector, ...toolParts] = toolName.split("__");
  const tool = toolParts.join("__");
  if (!connector || !tool) {
    return null;
  }

  return {
    connectorSlug: connector,
    label: `${humanizeIdentifier(connector)} > ${humanizeIdentifier(tool)}`,
  };
};

const humanizeIdentifier = (value: string): string =>
  value
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(/^\p{L}/u, (match) => match.toLocaleUpperCase());

const TOOL_ICONS: Record<string, typeof SearchIcon> = {
  "ask-user": CircleHelpIcon,
  "describe-stella-api": CircleHelpIcon,
  "describe-stella-function": CircleHelpIcon,
  "execute-typescript": CodeIcon,
  "run-stella-query": CodeIcon,
  "load-skill": LibraryIcon,
  "read-contact": UserIcon,
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
  const mcpToolInfo = getMcpToolInfo(name);
  const { data: mcpConnectorsData } = useQuery({
    ...mcpConnectorsOptions(),
    enabled: mcpToolInfo !== null,
  });
  const [expanded, setExpanded] = useState(() =>
    Boolean(
      showDetails &&
      (CODE_TOOL_NAMES.has(name) ||
        name === "load-skill" ||
        name === "read-skill-resource"),
    ),
  );
  const Icon = TOOL_ICONS[name] ?? SearchIcon;
  const label = mcpToolInfo?.label ?? t(getChatToolTitleKey(name));
  const mcpIconHref =
    mcpToolInfo === null
      ? undefined
      : findMcpConnectorIconHref({
          connectorSlug: mcpToolInfo.connectorSlug,
          connectors: mcpConnectorsData?.connectors ?? [],
        });
  const subtitle = getToolSubtitle({
    formatCharacterCount: (count) =>
      t("chat.toolCall.characterCount", { count }),
    part,
    toolName: name,
  });

  const isLoading = isRunningToolPart(part);
  const hasOutput = part.state === "output-available";
  const hasError = part.state === "output-error";
  const toolInput = getToolInput(part);
  const codeToolSource = getCodeToolSource(part, name);
  const showCodeToolOutput = CODE_TOOL_NAMES.has(name) && hasOutput;
  const showMcpExactCall = mcpToolInfo !== null && toolInput !== undefined;
  const canExpand =
    showMcpExactCall ||
    codeToolSource !== undefined ||
    showCodeToolOutput ||
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
        <ToolCallLeadingIcon
          Icon={Icon}
          iconHref={mcpIconHref}
          isLoading={isLoading}
        />
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
        (showMcpExactCall ||
          codeToolSource !== undefined ||
          showCodeToolOutput ||
          (showDetails && toolInput !== undefined) ||
          (showDetails && hasOutput)) && (
          <div className="space-y-2 border-t px-2 py-1.5">
            {showMcpExactCall && (
              <div>
                <div className="text-muted-foreground mb-1 text-[11px] font-medium">
                  {t("chat.toolCall.exactCall")}
                </div>
                <pre className="text-muted-foreground max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
                  {`${name}\n${JSON.stringify(toolInput, null, 2)}`}
                </pre>
              </div>
            )}
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
            {codeToolSource !== undefined && (
              <div>
                <div className="text-muted-foreground mb-1 text-[11px] font-medium">
                  {t("chat.toolCall.sourceCode")}
                </div>
                <pre className="bg-background/60 text-foreground max-h-96 overflow-auto rounded border px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
                  {codeToolSource}
                </pre>
              </div>
            )}
            {hasOutput &&
              (showDetails || showCodeToolOutput) &&
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

function ToolCallLeadingIcon({
  Icon,
  iconHref,
  isLoading,
}: {
  Icon: typeof SearchIcon;
  iconHref?: string | undefined;
  isLoading: boolean;
}) {
  if (iconHref) {
    return (
      <span className="bg-background relative flex size-4 shrink-0 items-center justify-center rounded-sm border">
        <img
          alt=""
          className={cn(
            "size-3 rounded-[2px] object-contain",
            isLoading && "opacity-70",
          )}
          height={12}
          src={iconHref}
          width={12}
        />
        {isLoading && (
          <span className="border-foreground/20 border-t-foreground absolute -inset-0.5 animate-spin rounded-sm border" />
        )}
      </span>
    );
  }

  if (isLoading) {
    return (
      <div className="border-foreground/20 border-t-foreground size-3 animate-spin rounded-full border" />
    );
  }

  return <Icon className="text-muted-foreground size-3 shrink-0" />;
}

const findMcpConnectorIconHref = ({
  connectorSlug,
  connectors,
}: {
  connectorSlug: string;
  connectors: {
    iconUrl: string | null;
    slug: string;
    url: string;
  }[];
}): string | undefined => {
  const connector = connectors.find(
    (item) => sanitizeMcpToolNamePart(item.slug) === connectorSlug,
  );
  if (!connector) {
    return undefined;
  }

  const iconHref = connector.iconUrl ?? fallbackIconUrl(connector.url);
  return iconHref === undefined ? undefined : sanitizeHref(iconHref);
};

const sanitizeMcpToolNamePart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");

const fallbackIconUrl = (rawUrl: string): string | undefined => {
  try {
    return new URL("/favicon.ico", rawUrl).toString();
  } catch {
    return undefined;
  }
};
