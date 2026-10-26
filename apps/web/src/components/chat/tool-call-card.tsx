import { memo, useState } from "react";

import type { QueryClient } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon, CircleHelpIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { StatusMark } from "@stll/ui/status-mark";
import type { StatusMarkStatus } from "@stll/ui/status-mark";
import { cn } from "@stll/ui/utils";

import { CHAT_PENDING_TEXT_CLASS } from "@/components/chat/chat-pending-text";
import {
  type ChatToolCallPart,
  getChatToolTitleKey,
  isRunningToolPart,
} from "@/components/chat/chat-ui-tools";
import { ToolCallCodeBlock } from "@/components/chat/tool-call-code-block";
import {
  advanceToolCallTiming,
  createToolCallTiming,
} from "@/components/chat/tool-call-timing.logic";
import { UnrestoredFieldsNotice } from "@/components/chat/unrestored-fields-notice";
import {
  BUILT_IN_SKILL_ORIGIN,
  parseSkillResourceSource,
  type SkillResourceSource,
} from "@/components/inspector/inspector-store-types";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { findInstalledSkillDisplayName } from "@/components/inspector/skill-display-name.logic";
import Tooltip from "@/components/tooltip";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { mcpConnectorsOptions, skillsOptions } from "@/lib/knowledge/queries";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

type ToolPart = ChatToolCallPart;

const getToolInput = (part: ToolPart): unknown => {
  if (!("input" in part)) {
    return undefined;
  }

  return part.input;
};

// `execute_typescript` is the live code-mode runner; `execute-typescript`
// (hyphen) and `run-stella-query` are its retired predecessors, kept so
// historical threads still render as code cards.
const CODE_TOOL_NAMES = {
  "execute-typescript": true,
  execute_typescript: true,
  "run-stella-query": true,
} as const;
// Input keys that carry the sandbox source across the live and legacy code
// tools: code-mode's `execute_typescript` uses `typescriptCode`; the retired
// tools used `code`.
const CODE_SOURCE_INPUT_KEYS = ["typescriptCode", "code"] as const;
const SKILL_RESOURCE_OUTPUT_TOOL_NAMES = {
  "create-current-skill-resource": true,
  "read-skill-resource": true,
  "update-current-skill-body": true,
  "update-current-skill-resource": true,
} as const;
const SKILL_RESOURCE_REFRESH_OUTPUT_TOOL_NAMES = {
  "update-current-skill-body": true,
  "update-current-skill-resource": true,
} as const;

const isCodeToolName = (name: string): boolean =>
  Object.hasOwn(CODE_TOOL_NAMES, name);

const isSkillResourceOutputToolName = (name: string): boolean =>
  Object.hasOwn(SKILL_RESOURCE_OUTPUT_TOOL_NAMES, name);

const getCodeToolSource = (
  part: ToolPart,
  toolName: string,
): string | undefined => {
  if (!isCodeToolName(toolName)) {
    return undefined;
  }
  const input = getToolInput(part);
  if (input === undefined || input === null || typeof input !== "object") {
    return undefined;
  }
  for (const key of CODE_SOURCE_INPUT_KEYS) {
    const value = getStringProperty(input, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
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
  if (!Object.hasOwn(input, key)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  const value: unknown = descriptor?.value;
  return typeof value === "string" ? value : undefined;
};

// `discover_tools` input is `{ toolNames: string[] }`. Names are catalogued in
// `external_<name>` form; strip the prefix for a human-readable subtitle.
const getDiscoverToolNames = (part: ToolPart): string[] => {
  const input = getToolInput(part);
  if (input === undefined || input === null || typeof input !== "object") {
    return [];
  }
  const raw: unknown = Reflect.get(input, "toolNames");
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.replace(/^external_/u, ""));
};

// Console output captured by a code-mode `execute_typescript` run
// (`CodeModeToolResult.logs`). Legacy code tools returned no logs array, so this
// is empty for them and the raw-output block still renders their result.
const getCodeToolLogs = (part: ToolPart): string[] => {
  if (!("output" in part)) {
    return [];
  }
  const output: unknown = part.output;
  if (output === null || typeof output !== "object") {
    return [];
  }
  const raw: unknown = Reflect.get(output, "logs");
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((line): line is string => typeof line === "string");
};

type SkillResourceTarget = "body" | "resource";

type SkillResourceOutput = {
  skillName: string;
  path: string;
  content: string;
  mimeType: string;
  source: SkillResourceSource;
  target?: SkillResourceTarget | undefined;
};

const getStringProperty = (source: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" ? value : undefined;
};

const isSkillResourceTarget = (value: unknown): value is SkillResourceTarget =>
  value === "body" || value === "resource";

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
  const source = parseSkillResourceSource(
    Reflect.get(output, "skillId"),
    Reflect.get(output, "origin"),
  );
  const targetRaw: unknown = Reflect.get(output, "target");
  if (
    skillName === undefined ||
    path === undefined ||
    content === undefined ||
    mimeType === undefined ||
    source === undefined
  ) {
    return undefined;
  }
  return {
    skillName,
    path,
    content,
    mimeType,
    source,
    ...(isSkillResourceTarget(targetRaw) ? { target: targetRaw } : {}),
  };
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
    case "execute_typescript":
    case "execute-typescript":
    case "run-stella-query": {
      const source = getCodeToolSource(part, toolName);
      return source ? formatCharacterCount(source.length) : null;
    }
    case "discover_tools": {
      const names = getDiscoverToolNames(part);
      return names.length > 0 ? names.join(", ") : null;
    }
    case "load-skill":
      return getStringInputValue({ key: "skillName", part }) ?? null;
    case "create-current-skill-resource":
    case "read-skill-resource": {
      const skillName = getStringInputValue({ key: "skillName", part });
      const resourcePath = getStringInputValue({ key: "path", part });
      if (!skillName || !resourcePath) {
        return resourcePath ?? null;
      }

      return `${skillName}: ${resourcePath}`;
    }
    case "update-current-skill-body":
      return "SKILL.md";
    case "update-current-skill-resource":
      return getStringInputValue({ key: "path", part }) ?? null;
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

const NATIVE_TOOL_BRANDS: Record<string, string> = {
  // Historical aliases for chat history that predates the unified
  // `business_registry_lookup` tool. New turns route through the
  // unified tool; the per-jurisdiction brand is resolved at render
  // time from the call input rather than from the tool name.
  ares_lookup_company: "ARES",
  ares_search_companies: "ARES",
};

type CatalogEntry = {
  brand: string;
};

type CatalogItem = {
  slug: string;
  displayName: string;
};

const findCatalogEntry = ({
  toolName,
  mcpToolInfo,
  connectors,
}: {
  toolName: string;
  mcpToolInfo: McpToolInfo | null;
  connectors: CatalogItem[];
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
    };
  }

  const nativeBrand = NATIVE_TOOL_BRANDS[toolName];
  if (nativeBrand === undefined) {
    return null;
  }
  return {
    brand: nativeBrand,
  };
};

// A built-in's title follows the reader's language, so only an installed
// skill's tab stores one. The chat routes load the skills list, so its title
// is read from the cache, which is kept per user; without a signed-in user
// (the dev playground) or the cache, the tab shows the slug.
const skillResourceTabSource = ({
  organizationId,
  queryClient,
  source,
  user,
}: {
  organizationId: string;
  queryClient: QueryClient;
  source: SkillResourceSource;
  user: AuthenticatedUser | null;
}) => {
  if (source.origin === BUILT_IN_SKILL_ORIGIN || user === null) {
    return source;
  }
  const skillDisplayName = findInstalledSkillDisplayName({
    pages: queryClient.getQueryData(
      skillsOptions(organizationId, user.id).queryKey,
    )?.pages,
    skillId: source.skillId,
  });
  return skillDisplayName === undefined
    ? source
    : { ...source, skillDisplayName };
};

// The mark a call shows when it is neither running nor failed. Approval and
// user-input states wait on a person, so they read as pending, never done.
const TOOL_CALL_SETTLED_STATUS = {
  "approval-requested": "pending",
  "approval-responded": "pending",
  "awaiting-input": "pending",
  complete: "done",
  error: "failed",
  "input-complete": "pending",
  "input-streaming": "pending",
} as const satisfies Record<ToolPart["state"], StatusMarkStatus>;

const toolCallStatus = ({
  hasError,
  isRunning,
  state,
}: {
  hasError: boolean;
  isRunning: boolean;
  state: ToolPart["state"];
}): StatusMarkStatus => {
  if (hasError) {
    return "failed";
  }
  return isRunning ? "running" : TOOL_CALL_SETTLED_STATUS[state];
};

const TOOL_CALL_STATUS_LABEL_KEYS = {
  done: "common.done",
  pending: "chat.toolCall.statusWaiting",
  running: "common.running",
} as const satisfies Record<Exclude<StatusMarkStatus, "failed">, string>;

/** A follow-up a tool row offers once its call completed, such as opening
 *  what the call saved. */
export type ToolCallAction = { label: string; onClick: () => void };

export const toolFailureLabelKey = (
  rawErrorDetails: ReturnType<typeof getToolOutputError>,
  state: ToolPart["state"],
) => {
  if (rawErrorDetails !== undefined) {
    return "chat.toolCall.failed";
  }
  return state === "error" ? "chat.toolCall.interrupted" : undefined;
};

const ToolCallCardComponent = ({
  action,
  activeOrganizationId,
  durationMs,
  part,
  showDetails,
}: {
  action?: ToolCallAction | undefined;
  activeOrganizationId: string;
  /** Known elapsed time, used by persisted callers and visual fixtures. */
  durationMs?: number;
  part: ToolPart;
  /** Open rich tool details initially in development surfaces. */
  showDetails?: boolean;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const name = part.name;
  const mcpToolInfo = getMcpToolInfo(name);
  const catalogDataQuery = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled: mcpToolInfo !== null,
  });
  const catalogDataView = useQueryView(catalogDataQuery);
  useQueryViewError(catalogDataView, "ToolCallCard:query");
  const catalogData =
    catalogDataView.type === "items" ? catalogDataView.items : undefined;
  const connectors = catalogData ? catalogData.connectors : [];
  const catalogEntry = findCatalogEntry({
    toolName: name,
    mcpToolInfo,
    connectors,
  });
  const [expanded, setExpanded] = useState(() =>
    Boolean(
      showDetails &&
      (isCodeToolName(name) ||
        name === "load-skill" ||
        isSkillResourceOutputToolName(name)),
    ),
  );
  const label = catalogEntry?.brand ?? t(getChatToolTitleKey(name));
  const subtitle = getToolSubtitle({
    formatCharacterCount: (count) =>
      t("chat.toolCall.characterCount", { count }),
    part,
    toolName: name,
  });

  const isLoading = isRunningToolPart(part);
  const [timing, setTiming] = useState(() =>
    createToolCallTiming({
      durationMs,
      isRunning: isLoading,
      now: Temporal.Now.instant().epochMilliseconds,
    }),
  );
  useExternalSyncEffect(() => {
    setTiming((current) =>
      advanceToolCallTiming({
        current,
        durationMs,
        isRunning: isLoading,
        now: Temporal.Now.instant().epochMilliseconds,
      }),
    );
  }, [durationMs, isLoading]);
  const elapsed =
    timing.status === "finished" && timing.durationMs !== undefined
      ? format.number(Math.max(1, Math.round(timing.durationMs / 1000)), {
          style: "unit",
          unit: "second",
          unitDisplay: "narrow",
        })
      : null;
  const hasOutput = part.output !== undefined;
  // Raw tool errors are written for the model (they drive its retry policy),
  // not for people: render a short human line instead and keep the raw text
  // behind a collapsed disclosure for debugging. A tool-call rewritten to the
  // terminal "error" state at hydration (its stream died mid call, so it
  // never produced an `output.error`) still reads as failed via a generic
  // interrupted label.
  const rawErrorDetails = getToolOutputError(part.output);
  const failureLabelKey = toolFailureLabelKey(rawErrorDetails, part.state);
  const errorMessage =
    failureLabelKey === undefined ? undefined : t(failureLabelKey);
  const hasError = errorMessage !== undefined;
  const status = toolCallStatus({
    hasError,
    isRunning: isLoading,
    state: part.state,
  });
  const statusLabel =
    status === "failed" ? errorMessage : t(TOOL_CALL_STATUS_LABEL_KEYS[status]);
  const toolInput = getToolInput(part);
  const codeToolSource = getCodeToolSource(part, name);
  const showCodeToolOutput = isCodeToolName(name) && hasOutput;
  const codeToolLogs = showCodeToolOutput ? getCodeToolLogs(part) : [];
  const showMcpExactCall = mcpToolInfo !== null && toolInput !== undefined;
  const skillResourceOutput =
    isSkillResourceOutputToolName(name) && hasOutput
      ? getSkillResourceOutput(part)
      : undefined;
  const canExpand =
    showMcpExactCall ||
    codeToolSource !== undefined ||
    showCodeToolOutput ||
    toolInput !== undefined ||
    hasOutput;
  const headerOpensSkillResource = skillResourceOutput !== undefined;
  const headerInteractive = headerOpensSkillResource || canExpand;

  return (
    <div className="my-0.5 max-w-xl text-sm">
      <Tooltip
        content={errorMessage}
        render={
          <div
            className={cn(
              "group/tool-step hover:bg-muted/35 focus-within:bg-muted/35 flex max-w-full items-center rounded-lg",
              hasError &&
                "bg-destructive/10 text-destructive hover:bg-destructive/15",
            )}
          />
        }
      >
        <button
          className={cn(
            "flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 text-start",
            !hasError &&
              "text-muted-foreground group-hover/tool-step:text-foreground-muted",
            !headerInteractive && "cursor-default",
          )}
          onClick={() => {
            if (skillResourceOutput) {
              useInspectorTabsStore.getState().openSkillResourceTab({
                ...skillResourceTabSource({
                  organizationId: activeOrganizationId,
                  queryClient,
                  source: skillResourceOutput.source,
                  user,
                }),
                skillName: skillResourceOutput.skillName,
                resourcePath: skillResourceOutput.path,
                mimeType: skillResourceOutput.mimeType,
                content: skillResourceOutput.content,
                label: basenameOf(skillResourceOutput.path),
                refreshContent: Object.hasOwn(
                  SKILL_RESOURCE_REFRESH_OUTPUT_TOOL_NAMES,
                  name,
                ),
                ...(skillResourceOutput.target
                  ? { target: skillResourceOutput.target }
                  : {}),
              });
              return;
            }
            if (canExpand) {
              setExpanded((e) => !e);
            }
          }}
          type="button"
        >
          <StatusMark label={statusLabel} status={status} />
          <span
            className={cn(
              "min-w-0 truncate",
              isLoading && CHAT_PENDING_TEXT_CLASS,
            )}
          >
            <span>{label}</span>
            {subtitle && (
              <span
                className={cn("ms-1.5", !isLoading && "text-foreground-ghost")}
              >
                {subtitle}
              </span>
            )}
          </span>
          {elapsed && (
            <span className="text-foreground-ghost shrink-0 text-xs font-normal tabular-nums">
              {elapsed}
            </span>
          )}
        </button>
        {action !== undefined && (
          <Button
            className="me-1 shrink-0"
            onClick={action.onClick}
            size="xs"
            type="button"
            variant="ghost"
          >
            {action.label}
          </Button>
        )}
        {mcpToolInfo !== null && (
          <Popover>
            <PopoverTrigger
              aria-label={t("knowledge.mcp.whatIsAnMcpServer")}
              render={
                <Button
                  className="size-11 shrink-0"
                  size="icon"
                  variant="muted"
                />
              }
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
        {canExpand && (
          <button
            aria-label={t("chat.toolCall.toggleDetails")}
            className={cn(
              "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-11 shrink-0 items-center justify-center rounded opacity-0 transition-opacity duration-150 group-hover/tool-step:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none",
              expanded && "opacity-100",
            )}
            onClick={() => {
              setExpanded((e) => !e);
            }}
            type="button"
          >
            <DirectionalIcon
              className={cn(
                "size-3.5 transition-transform duration-150",
                expanded && "rotate-90",
              )}
              flip={!expanded}
              icon={ChevronRightIcon}
            />
          </button>
        )}
      </Tooltip>
      {expanded &&
        (showMcpExactCall ||
          codeToolSource !== undefined ||
          showCodeToolOutput ||
          toolInput !== undefined ||
          hasOutput) && (
          <div className="space-y-1 ps-2 pt-1 pb-2">
            {showMcpExactCall && (
              <ToolCallCodeBlock
                code={JSON.stringify({ input: toolInput, tool: name }, null, 2)}
                label={t("chat.toolCall.exactCall")}
                language="json"
                tone="call"
              />
            )}
            {!showMcpExactCall &&
              codeToolSource === undefined &&
              toolInput !== undefined && (
                <ToolCallCodeBlock
                  code={JSON.stringify(toolInput, null, 2)}
                  label={t("chat.toolCall.input")}
                  language="json"
                  tone="call"
                />
              )}
            {codeToolSource !== undefined && (
              <ToolCallCodeBlock
                code={codeToolSource}
                label={t("chat.toolCall.sourceCode")}
                language="typescript"
                lineNumbers
                tone="call"
              />
            )}
            {codeToolLogs.length > 0 && (
              <ToolCallCodeBlock
                code={codeToolLogs.join("\n")}
                label={t("chat.toolCall.consoleLogs")}
                language="text"
                tone="result"
              />
            )}
            {hasOutput && "output" in part && (
              <ToolCallCodeBlock
                code={JSON.stringify(part.output, null, 2)}
                label={t("chat.toolCall.output")}
                language="json"
                tone="result"
              />
            )}
          </div>
        )}
      {hasError && errorMessage && (
        <ToolCallFailureDetails
          errorMessage={errorMessage}
          rawErrorDetails={rawErrorDetails}
        />
      )}
      <UnrestoredFieldsNotice output={part.output} />
    </div>
  );
};

// A response can stream many tool calls, and each new chunk re-renders the
// message's part list: a card whose call did not change skips that render.
export const ToolCallCard = memo(ToolCallCardComponent);

/** The short human failure line, with the raw tool error (written for the
 *  model, not for people) behind a collapsed disclosure for debugging. */
export const ToolCallFailureDetails = ({
  errorMessage,
  rawErrorDetails,
}: {
  errorMessage: string;
  rawErrorDetails: string | undefined;
}) => {
  const t = useTranslations();
  return (
    <div className="max-w-xl py-1">
      <p className="text-destructive text-2xs leading-relaxed">
        {errorMessage}
      </p>
      {rawErrorDetails !== undefined && (
        <details className="group">
          <summary className="text-muted-foreground hover:text-foreground text-2xs cursor-pointer">
            <span className="group-open:hidden">{t("common.showDetails")}</span>
            <span className="hidden group-open:inline">
              {t("common.hideDetails")}
            </span>
          </summary>
          <ToolCallCodeBlock
            code={rawErrorDetails}
            label={t("chat.toolCall.output")}
            language="text"
            tone="result"
          />
        </details>
      )}
    </div>
  );
};

export const getToolOutputError = (output: unknown): string | undefined => {
  if (typeof output === "string") {
    return undefined;
  }
  if (typeof output !== "object" || output === null || !("error" in output)) {
    return undefined;
  }
  const error = output.error;
  if (typeof error === "string") {
    return error;
  }
  // code-mode's CodeModeToolResult surfaces failures as
  // `{ error: { message, name?, line? } }`; unwrap the message so a failed
  // execute_typescript renders its cause rather than a generic fallback.
  if (typeof error === "object" && error !== null) {
    return getStringProperty(error, "message");
  }
  return undefined;
};

const sanitizeMcpToolNamePart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/gu, "_");
