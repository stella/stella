import { useState } from "react";

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
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

import {
  getChatToolTitleKey,
  isRunningToolPart,
} from "@/components/chat/chat-ui-tools";
import { sanitizeHref } from "@/lib/sanitize-href";
import { mcpConnectorsOptions } from "@/routes/_protected.knowledge/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

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

type SkillResourceOrigin = "built-in" | "upload" | "url";

type SkillResourceOutput = {
  skillName: string;
  path: string;
  content: string;
  mimeType: string;
  skillId: string | null;
  origin: SkillResourceOrigin;
};

const getStringProperty = (source: object, key: string): string | undefined => {
  if (!(key in source)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  const value: unknown = descriptor?.value;
  return typeof value === "string" ? value : undefined;
};

const isSkillResourceOrigin = (value: unknown): value is SkillResourceOrigin =>
  value === "built-in" || value === "upload" || value === "url";

const getNullableStringProperty = (
  source: object,
  key: string,
): string | null | undefined => {
  if (!(key in source)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  const value: unknown = descriptor?.value;
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
};

const getSkillResourceOutput = (
  part: ToolPart,
): SkillResourceOutput | undefined => {
  if (!("output" in part)) {
    return undefined;
  }
  const output: unknown = part.output;
  if (output === null || typeof output !== "object") {
    return undefined;
  }
  const skillName = getStringProperty(output, "skillName");
  const path = getStringProperty(output, "path");
  const content = getStringProperty(output, "content");
  const mimeType = getStringProperty(output, "mimeType");
  const skillId = getNullableStringProperty(output, "skillId");
  const originRaw: unknown = "origin" in output
    ? Object.getOwnPropertyDescriptor(output, "origin")?.value
    : undefined;
  if (
    skillName === undefined ||
    path === undefined ||
    content === undefined ||
    mimeType === undefined ||
    skillId === undefined ||
    !isSkillResourceOrigin(originRaw)
  ) {
    return undefined;
  }
  return { skillName, path, content, mimeType, skillId, origin: originRaw };
};

const basenameOf = (path: string): string => {
  const segments = path.split("/");
  const last = segments.at(-1);
  return last && last.length > 0 ? last : path;
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
    case "fetch_url": {
      const url = getStringInputValue({ key: "url", part });
      if (!url) {
        return null;
      }
      try {
        return new URL(url).hostname.replace(/^www\./u, "");
      } catch {
        return url;
      }
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

  return { connectorSlug: connector };
};

const NATIVE_TOOL_BRANDS: Record<string, { slug: string; brand: string }> = {
  ares_lookup_company: { slug: "ares", brand: "ARES" },
  ares_search_companies: { slug: "ares", brand: "ARES" },
};

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

type CatalogEntry = {
  brand: string;
  iconHref: string | undefined;
};

type CatalogItem = {
  slug: string;
  displayName: string;
  description: string;
  url: string;
  iconUrl: string | null;
};

const findCatalogEntry = ({
  toolName,
  mcpToolInfo,
  connectors,
  nativeTools,
}: {
  toolName: string;
  mcpToolInfo: McpToolInfo | null;
  connectors: CatalogItem[];
  nativeTools: CatalogItem[];
}): CatalogEntry | null => {
  if (mcpToolInfo !== null) {
    const connector = connectors.find(
      (item) =>
        sanitizeMcpToolNamePart(item.slug) === mcpToolInfo.connectorSlug,
    );
    if (!connector) {
      return null;
    }
    return {
      brand: connector.displayName,
      iconHref: resolveIconHref(connector),
    };
  }

  const native = NATIVE_TOOL_BRANDS[toolName];
  if (native === undefined) {
    return null;
  }
  const tool = nativeTools.find((item) => item.slug === native.slug);
  return {
    brand: native.brand,
    iconHref: tool === undefined ? undefined : resolveIconHref(tool),
  };
};

const resolveIconHref = (item: CatalogItem): string | undefined => {
  const raw = item.iconUrl ?? fallbackIconUrl(item.url);
  return raw === undefined ? undefined : sanitizeHref(raw);
};

export const ToolCallCard = ({
  activeOrganizationId,
  part,
  showDetails,
}: {
  activeOrganizationId: string;
  part: ToolPart;
  /** Show expandable raw output (dev mode). */
  showDetails?: boolean;
}) => {
  const t = useTranslations();
  const name = getToolName(part);
  const mcpToolInfo = getMcpToolInfo(name);
  const hasCatalogEntry =
    mcpToolInfo !== null || NATIVE_TOOL_BRANDS[name] !== undefined;
  const { data: catalogData } = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled: hasCatalogEntry,
  });
  const catalogEntry = findCatalogEntry({
    toolName: name,
    mcpToolInfo,
    connectors: catalogData?.connectors ?? [],
    nativeTools: catalogData?.nativeTools ?? [],
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
  const label = catalogEntry?.brand ?? t(getChatToolTitleKey(name));
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
  const skillResourceOutput =
    name === "read-skill-resource" && hasOutput
      ? getSkillResourceOutput(part)
      : undefined;
  const canExpand =
    showMcpExactCall ||
    codeToolSource !== undefined ||
    showCodeToolOutput ||
    (showDetails && toolInput !== undefined) ||
    (showDetails && hasOutput);
  const headerOpensSkillResource = skillResourceOutput !== undefined;
  const headerInteractive = headerOpensSkillResource || canExpand;

  return (
    <div className="my-1 text-xs">
      <div
        className={cn(
          "bg-muted/30 inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 align-top",
          hasError && "border-destructive/40 border",
        )}
      >
        <button
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-start",
            !headerInteractive && "cursor-default",
          )}
          onClick={() => {
            if (skillResourceOutput) {
              useInspectorStore.getState().openSkillResourceTab({
                skillName: skillResourceOutput.skillName,
                skillId: skillResourceOutput.skillId,
                origin: skillResourceOutput.origin,
                resourcePath: skillResourceOutput.path,
                mimeType: skillResourceOutput.mimeType,
                content: skillResourceOutput.content,
                label: basenameOf(skillResourceOutput.path),
              });
              return;
            }
            if (canExpand) {
              setExpanded((e) => !e);
            }
          }}
          type="button"
        >
          <ToolCallLeadingIcon
            Icon={Icon}
            iconHref={catalogEntry?.iconHref}
            isLoading={isLoading}
          />
          <span className="min-w-0 truncate">
            <span className="font-medium">{label}</span>
            {subtitle && (
              <span className="text-muted-foreground ms-1.5">{subtitle}</span>
            )}
          </span>
        </button>
        {mcpToolInfo !== null && (
          <Popover>
            <PopoverTrigger
              aria-label={t("knowledge.mcp.whatIsAnMcpServer")}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded focus-visible:ring-2 focus-visible:outline-none"
            >
              <CircleHelpIcon className="size-3" />
            </PopoverTrigger>
            <PopoverPopup
              align="start"
              className="max-w-xs text-xs"
              sideOffset={6}
            >
              {t("knowledge.mcp.mcpExplainer")}
            </PopoverPopup>
          </Popover>
        )}
        {canExpand && (!headerOpensSkillResource || showDetails) && (
          <button
            aria-label={t("chat.toolCall.toggleDetails")}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded focus-visible:ring-2 focus-visible:outline-none"
            onClick={() => {
              setExpanded((e) => !e);
            }}
            type="button"
          >
            <ChevronDownIcon
              className={cn(
                "size-3 transition-transform",
                expanded && "rotate-180",
              )}
            />
          </button>
        )}
      </div>
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

const sanitizeMcpToolNamePart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/gu, "_");

const fallbackIconUrl = (rawUrl: string): string | undefined => {
  try {
    return new URL("/favicon.ico", rawUrl).toString();
  } catch {
    return undefined;
  }
};
