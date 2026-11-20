import { memo, useState } from "react";
import type { ReactNode } from "react";

import type { QueryClient } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  getCodeToolSource,
  isCodeToolName,
  summarizeCodeToolSource,
} from "@stll/api-contract/chat-code-step";
import {
  isLocalRunInterruptedOutput,
  localRunStepFailed,
  localRunToolView,
} from "@stll/api-contract/chat-local-run-steps";
import { withoutChatStepLedger } from "@stll/api-contract/chat-step-ledger";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon, CircleHelpIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { StatusMark } from "@stll/ui/status-mark";
import type { StatusMarkStatus } from "@stll/ui/status-mark";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { CHAT_PENDING_TEXT_CLASS } from "@/components/chat/chat-pending-text";
import {
  type ChatToolCallPart,
  type HarnessChatToolCallPart,
  isRunningToolPart,
  LOCAL_RUN_TITLE_KEYS,
} from "@/components/chat/chat-ui-tools";
import { LocalRunStepOutputDetails } from "@/components/chat/local-run-step-output";
import { useLocalRunSubtitleText } from "@/components/chat/local-run-subtitle";
import type { ChatAnswerCitations } from "@/components/chat/source-chips.logic";
import { skillMdName } from "@/components/chat/tool-approval-summary";
import { ToolCallCodeBlock } from "@/components/chat/tool-call-code-block";
import {
  STEP_DIGEST_NOT_RECORDED_KEY,
  ToolCallStepDigest,
} from "@/components/chat/tool-call-step-digest";
import {
  type StepDigest,
  stepDigestOf,
} from "@/components/chat/tool-call-step-digest.logic";
import {
  advanceToolCallTiming,
  createToolCallTiming,
} from "@/components/chat/tool-call-timing.logic";
import { getToolCallTitleKey } from "@/components/chat/tool-call-title.logic";
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
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { mcpConnectorsOptions, skillsOptions } from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/** A stella or connector tool's call, or a coding agent's own step. */
type ToolPart = ChatToolCallPart | HarnessChatToolCallPart;

/** A card rendered outside an answer (a fixture, an approval) cites nothing. */
const NO_ANSWER_CITATIONS: ChatAnswerCitations = {
  appOrigins: new Set(),
  decisionIds: new Set(),
  hrefKeys: new Set(),
};

const getToolInput = (part: ToolPart): unknown => {
  if (!("input" in part)) {
    return undefined;
  }

  return part.input;
};

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

const isSkillResourceOutputToolName = (name: string): boolean =>
  Object.hasOwn(SKILL_RESOURCE_OUTPUT_TOOL_NAMES, name);

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
  formatLookupCount,
  part,
  toolName,
}: {
  formatLookupCount: (count: number) => string;
  part: ToolPart;
  toolName: string;
}) => {
  switch (toolName) {
    case "execute_typescript":
    case "execute-typescript":
    case "run-stella-query": {
      const source = getCodeToolSource({
        input: getToolInput(part),
        name: toolName,
      });
      if (source === undefined) {
        return null;
      }
      // What was looked up, never how the lookup was written.
      const { lookupCount, topic } = summarizeCodeToolSource(source);
      const shown = [
        ...(topic === undefined ? [] : [topic]),
        ...(lookupCount > 1 ? [formatLookupCount(lookupCount)] : []),
      ];
      return shown.length > 0 ? shown.join(" · ") : null;
    }
    // The catalogue it fetches is the model's business; the title says what
    // the step is for.
    case "discover_tools":
      return null;
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
    case "save_skill_package":
    case "validate_skill_package":
      return skillMdName(getStringInputValue({ key: "skillMd", part }));
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
} as const satisfies Record<
  ToolPart["state"],
  Exclude<StatusMarkStatus, "running">
>;

const TOOL_CALL_STATUS_LABEL_KEYS = {
  done: "common.done",
  pending: "chat.toolCall.statusWaiting",
} as const satisfies Record<
  Exclude<StatusMarkStatus, "failed" | "running">,
  string
>;

/** A follow-up a tool row offers once its call completed, such as opening
 *  what the call saved. */
export type ToolCallAction = { label: string; onClick: () => void };

/**
 * How a call that did not complete reads: interrupted only when it ended
 * with no result at all (its stream died mid call) or with the explicit
 * cancellation result; any other error result, an envelope, a step
 * reporting `failed` or a connector's plain-text error, reads as failed.
 */
export const toolFailureLabelKey = ({
  name,
  output,
  state,
}: {
  name: string;
  output: unknown;
  state: ToolPart["state"];
}) => {
  if (
    getToolOutputError(output) !== undefined ||
    localRunStepFailed(name, output)
  ) {
    return "chat.toolCall.failed";
  }
  if (state !== "error") {
    return undefined;
  }
  return output === undefined || isLocalRunInterruptedOutput(output)
    ? "chat.toolCall.interrupted"
    : "chat.toolCall.failed";
};

// Static marks make a running glyph impossible outside the turn owner.
const SettledToolStatusMark = ({
  label,
  status,
}: {
  label: string | undefined;
  status: Exclude<StatusMarkStatus, "running">;
}) => {
  switch (status) {
    case "done":
      return <StatusMark label={label} status="done" />;
    case "failed":
      return <StatusMark label={label} status="failed" />;
    case "pending":
      return <StatusMark label={label} status="pending" />;
    default:
      return panic("Unhandled settled tool status", {
        status: status satisfies never,
      });
  }
};

/**
 * How a failed step reads, by whether its turn went on past it: on to an
 * answer (or still working), or ended there without one.
 */
export type StepFailureOutcome = "recovered" | "terminal";

const ToolCallCardComponent = ({
  action,
  activeOrganizationId,
  answerCitations,
  durationMs,
  failureOutcome,
  turnStatus = "finished",
  part,
  showDetails,
  threadId,
}: {
  action?: ToolCallAction | undefined;
  activeOrganizationId: string;
  /** What the answer of this step's message cites, for "used in the answer". */
  answerCitations?: ChatAnswerCitations | undefined;
  /** Known elapsed time, used by persisted callers and visual fixtures. */
  durationMs?: number;
  /** What a failure of this step means for its turn. */
  failureOutcome: StepFailureOutcome;
  turnStatus?: "running" | "finished";
  part: ToolPart;
  /** Open rich tool details initially in development surfaces. */
  showDetails?: boolean;
  /** The thread the call belongs to; a local run's step reads its content by it. */
  threadId?: string | undefined;
}) => {
  const t = useTranslations();
  const localRunSubtitleText = useLocalRunSubtitleText();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const showTechnicalDetails =
    usePresentationPrefs().prefs.chatTechnicalDetails;
  const name = part.name;
  const mcpToolInfo = getMcpToolInfo(name);
  const catalogDataQuery = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled: mcpToolInfo !== null,
  });
  const catalogDataView = queryView(catalogDataQuery);
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
  // A step a coding agent took on the member's computer names what it was
  // about: its command, file names, search or plan.
  const localRunTool = localRunToolView({
    name,
    input: getToolInput(part),
    output: part.output,
  });
  const localRunTitleKind = localRunTool?.titleKind ?? null;
  const label =
    catalogEntry?.brand ??
    (localRunTitleKind === null
      ? t(
          getToolCallTitleKey({
            input: getToolInput(part),
            name,
            output: part.output,
          }),
        )
      : t(LOCAL_RUN_TITLE_KEYS[localRunTitleKind]));
  const subtitle =
    localRunTool === null
      ? getToolSubtitle({
          formatLookupCount: (count) =>
            t("chat.toolCall.lookupCount", { count }),
          part,
          toolName: name,
        })
      : localRunSubtitleText(localRunTool.subtitle);

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
    turnStatus === "finished" &&
    timing.status === "finished" &&
    timing.durationMs !== undefined
      ? format.number(Math.max(1, Math.round(timing.durationMs / 1000)), {
          style: "unit",
          unit: "second",
          unitDisplay: "narrow",
        })
      : null;
  const output: unknown = part.output;
  const hasOutput = output !== undefined;
  // Raw tool errors are written for the model (they drive its retry policy),
  // not for people: the status mark names the failure and the raw text stays
  // in the technical details. A tool-call rewritten to the terminal "error"
  // state at hydration (its stream died mid call, so it never produced an
  // `output.error`) still reads as failed via a generic interrupted label.
  const failureLabelKey = toolFailureLabelKey({
    name,
    output: part.output,
    state: part.state,
  });
  const errorMessage =
    failureLabelKey === undefined ? undefined : t(failureLabelKey);
  // A call its turn cut off (a stop, a new message) never finished; that is
  // not the tool failing, so it reads as stopped, without the failure tint.
  const stopped = failureLabelKey === "chat.toolCall.interrupted";
  const hasError = errorMessage !== undefined && !stopped;
  // A failure the turn went on past is part of the work, not its result: the
  // row stays calm and the reason waits behind the row's own disclosure.
  const failure = hasError ? failureOutcome : "none";
  const failureNote =
    failure === "recovered" ? t("chat.toolCall.retriedDetail") : errorMessage;
  const status = (() => {
    if (hasError) {
      return "failed";
    }
    return stopped ? "pending" : TOOL_CALL_SETTLED_STATUS[part.state];
  })();
  // A running call waits on nothing; the turn's live status names the work.
  const settledStatusLabel =
    errorMessage ??
    (status === "failed" ? undefined : t(TOOL_CALL_STATUS_LABEL_KEYS[status]));
  const statusLabel = isLoading ? undefined : settledStatusLabel;
  const toolInput = getToolInput(part);
  const codeToolSource = getCodeToolSource({ input: toolInput, name });
  const showMcpExactCall = mcpToolInfo !== null && toolInput !== undefined;
  const skillResourceOutput =
    isSkillResourceOutputToolName(name) && hasOutput
      ? getSkillResourceOutput(part)
      : undefined;
  const { canExpand, digest, technicalDetails } = toolCallDetailsView({
    answerCitations,
    failed: hasError,
    hasRecoveredNote: failure === "recovered",
    isLocalRun: localRunTool !== null,
    part: { input: toolInput, name, output },
    showMcpExactCall,
    showTechnicalDetails,
    technical: codeToolSource !== undefined || toolInput !== undefined,
  });
  const headerOpensSkillResource = skillResourceOutput !== undefined;
  const headerInteractive = headerOpensSkillResource || canExpand;
  // A finished step is part of the rail; only one still running, waiting or
  // failed draws a mark on it.
  const showsMark = isLoading || status !== "done";

  return (
    <div
      className={cn(
        "relative border-s text-sm leading-5",
        showsMark ? "border-s-transparent" : "border-border/60",
      )}
    >
      {showsMark && (
        <span className="absolute -start-[8.5px] top-2 flex pointer-coarse:top-3.5">
          {failure === "recovered" ? (
            <RecoveredStepDot />
          ) : (
            <SettledToolStatusMark label={statusLabel} status={status} />
          )}
        </span>
      )}
      <Tooltip
        content={failureNote}
        render={
          <div className="group/tool-step hover:bg-muted/35 focus-within:bg-muted/35 flex max-w-full items-center rounded-md" />
        }
      >
        {/* The row owns the hover tint; a plain button paints none of its
            own, so the header does not tint twice. */}
        <Button
          className={cn(
            "flex min-w-0 flex-1",
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
          variant="plain"
        >
          <ToolCallHeaderLabel
            elapsed={elapsed}
            failure={failure}
            isLoading={isLoading}
            label={label}
            statusLabel={showsMark ? undefined : statusLabel}
            subtitle={subtitle}
          />
        </Button>
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
                <Button className="shrink-0" size="icon-sm" variant="muted" />
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
          <ToolCallExpandToggle
            expanded={expanded}
            onToggle={() => {
              setExpanded((e) => !e);
            }}
          />
        )}
      </Tooltip>
      {expanded && canExpand && (
        <ToolCallDetails
          activeOrganizationId={activeOrganizationId}
          codeToolSource={codeToolSource}
          digest={digest}
          note={failure === "recovered" ? failureNote : undefined}
          part={part}
          showMcpExactCall={showMcpExactCall}
          showTechnicalDetails={technicalDetails}
          threadId={threadId}
        />
      )}
      <UnrestoredFieldsNotice output={output} />
    </div>
  );
};

// A response can stream many tool calls, and each new chunk re-renders the
// message's part list: a card whose call did not change skips that render.
export const ToolCallCard = memo(ToolCallCardComponent);

/**
 * What an opened step shows. A person reads what it looked up and found;
 * its call and raw result show only with the technical details setting on.
 * A coding agent's step opens onto what its computer stored instead.
 */
const toolCallDetailsView = ({
  answerCitations,
  failed,
  hasRecoveredNote,
  isLocalRun,
  part,
  showMcpExactCall,
  showTechnicalDetails,
  technical,
}: {
  answerCitations: ChatAnswerCitations | undefined;
  failed: boolean;
  hasRecoveredNote: boolean;
  isLocalRun: boolean;
  part: { input: unknown; name: string; output: unknown };
  showMcpExactCall: boolean;
  showTechnicalDetails: boolean;
  /** Whether the call carries a script or an input to show. */
  technical: boolean;
}) => {
  const hasOutput = part.output !== undefined;
  const isCodeStep = isCodeToolName(part.name) && hasOutput;
  const digest = isLocalRun
    ? null
    : stepDigestOf({
        citations: answerCitations ?? NO_ANSWER_CITATIONS,
        failed,
        part,
      });
  const technicalDetails =
    showTechnicalDetails && (showMcpExactCall || technical || hasOutput);
  return {
    // A code step with no ledger still opens, to say it kept none.
    canExpand:
      digest !== null ||
      isCodeStep ||
      isLocalRun ||
      hasRecoveredNote ||
      technicalDetails,
    digest,
    technicalDetails,
  };
};

/** The header's label and elapsed time. The colour is set here, since the
 *  header button paints none of its own and the row owns the hover tint. */
const ToolCallHeaderLabel = ({
  elapsed,
  failure,
  isLoading,
  label,
  statusLabel,
  subtitle,
}: {
  elapsed: string | null;
  failure: StepFailureOutcome | "none";
  isLoading: boolean;
  label: ReactNode;
  /** A finished step's status, which no mark announces. */
  statusLabel: string | undefined;
  subtitle: ReturnType<typeof getToolSubtitle>;
}) => {
  const t = useTranslations();
  // A failed step keeps the step colours; its status mark alone says it
  // failed, and the answer's footer says the turn did not finish.
  return (
    <span className="flex min-h-8 min-w-0 flex-1 items-center gap-2 ps-3 pe-2 text-sm leading-5 font-normal pointer-coarse:min-h-11">
      <TruncatedText
        render={<span className={cn(isLoading && CHAT_PENDING_TEXT_CLASS)} />}
      >
        <span className="text-foreground-label group-hover/tool-step:text-foreground">
          {label}
        </span>
        {subtitle && (
          <span className="text-muted-foreground ms-1.5">{subtitle}</span>
        )}
      </TruncatedText>
      {statusLabel !== undefined && (
        <span className="sr-only">{statusLabel}</span>
      )}
      {failure === "recovered" && (
        <span className="text-foreground-ghost shrink-0 text-xs">
          {t("chat.toolCall.retried")}
        </span>
      )}
      {elapsed && (
        <span
          data-tool-duration
          className="text-foreground-ghost shrink-0 text-xs font-normal tabular-nums"
        >
          {elapsed}
        </span>
      )}
    </span>
  );
};

/** A failure the turn went on past: a quiet warning dot on the rail; the
 *  row's trailing label says it was retried. */
const RecoveredStepDot = () => (
  <span aria-hidden="true" className="flex size-4 items-center justify-center">
    <span className="bg-warning size-1.5 rounded-full" />
  </span>
);

/** What a step looked up and found, behind the row's disclosure; its code
 *  and raw result only with the technical details setting on. */
const ToolCallDetails = ({
  activeOrganizationId,
  codeToolSource,
  digest,
  note,
  part,
  showMcpExactCall,
  showTechnicalDetails,
  threadId,
}: {
  activeOrganizationId: string;
  codeToolSource: string | undefined;
  digest: StepDigest | null;
  /** A plain line about the step, above what it found. */
  note: string | undefined;
  part: ToolPart;
  showMcpExactCall: boolean;
  showTechnicalDetails: boolean;
  threadId: string | undefined;
}) => {
  const t = useTranslations();
  const [technicalOpen, setTechnicalOpen] = useState(false);
  return (
    <div className="space-y-2 ps-3 pt-1 pb-2">
      {note !== undefined && (
        <p className="text-muted-foreground text-2xs leading-relaxed">{note}</p>
      )}
      {digest === null ? (
        isCodeToolName(part.name) &&
        part.output !== undefined && (
          <p className="text-muted-foreground text-2xs leading-relaxed">
            {t(STEP_DIGEST_NOT_RECORDED_KEY)}
          </p>
        )
      ) : (
        <ToolCallStepDigest digest={digest} />
      )}
      <LocalRunStepOutputDetails
        activeOrganizationId={activeOrganizationId}
        part={part}
        threadId={threadId}
      />
      {showTechnicalDetails && (
        <Collapsible onOpenChange={setTechnicalOpen} open={technicalOpen}>
          <CollapsibleTrigger render={<Button size="xs" variant="muted" />}>
            <DirectionalIcon
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-150",
                technicalOpen && "rotate-90",
              )}
              flip={!technicalOpen}
              icon={ChevronRightIcon}
            />
            {t("chat.stepDigest.technicalDetails")}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {/* Mounted only while open: a script and its raw result can be
                long, and a closed section has nothing to show. */}
            {technicalOpen && (
              <ToolCallTechnicalDetails
                codeToolSource={codeToolSource}
                part={part}
                showMcpExactCall={showMcpExactCall}
              />
            )}
          </CollapsiblePanel>
        </Collapsible>
      )}
    </div>
  );
};

/** A step's call and raw result as the tool saw them, for people who build
 *  with stella. */
const ToolCallTechnicalDetails = ({
  codeToolSource,
  part,
  showMcpExactCall,
}: {
  codeToolSource: string | undefined;
  part: ToolPart;
  showMcpExactCall: boolean;
}) => {
  const t = useTranslations();
  const toolInput = getToolInput(part);
  const hasOutput = part.output !== undefined;
  const codeToolLogs =
    isCodeToolName(part.name) && hasOutput ? getCodeToolLogs(part) : [];
  return (
    <div className="space-y-1 pt-1">
      {showMcpExactCall && (
        <ToolCallCodeBlock
          code={JSON.stringify({ input: toolInput, tool: part.name }, null, 2)}
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
      {hasOutput && (
        <ToolCallCodeBlock
          code={JSON.stringify(withoutChatStepLedger(part.output), null, 2)}
          label={t("chat.toolCall.output")}
          language="json"
          tone="result"
        />
      )}
    </div>
  );
};

/** Shows on the row's hover, its own focus, or always on touch; the wrapper
 *  carries the fade so the button keeps its own surface. */
const ToolCallExpandToggle = ({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) => {
  const t = useTranslations();
  return (
    <span
      className={cn(
        "flex shrink-0 opacity-0 transition-opacity duration-150 group-hover/tool-step:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
        expanded && "opacity-100",
      )}
    >
      <Button
        aria-expanded={expanded}
        aria-label={t("chat.toolCall.toggleDetails")}
        onClick={onToggle}
        size="icon-sm"
        variant="muted"
      >
        <DirectionalIcon
          className={cn(
            "size-3.5 transition-transform duration-150",
            expanded && "rotate-90",
          )}
          flip={!expanded}
          icon={ChevronRightIcon}
        />
      </Button>
    </span>
  );
};

/** A failed call's raw error, written for the model rather than for people,
 *  behind a collapsed disclosure, and only with the technical details
 *  setting on. A person reads the step's status mark and the answer's
 *  footer; no per-step failure line repeats them. */
export const ToolCallRawError = ({
  rawErrorDetails,
}: {
  rawErrorDetails: string | undefined;
}) => {
  const t = useTranslations();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const showRawError = usePresentationPrefs().prefs.chatTechnicalDetails;
  if (!showRawError || rawErrorDetails === undefined) {
    return null;
  }
  return (
    <div className="text-2xs py-1 ps-3">
      <Collapsible onOpenChange={setDetailsOpen} open={detailsOpen}>
        <CollapsibleTrigger render={<Button variant="plain" />}>
          <span className="text-muted-foreground hover:text-foreground">
            {detailsOpen ? t("common.hideDetails") : t("common.showDetails")}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ToolCallCodeBlock
            code={rawErrorDetails}
            label={t("chat.toolCall.output")}
            language="text"
            tone="result"
          />
        </CollapsiblePanel>
      </Collapsible>
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
