import { useRef, useState, useSyncExternalStore } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_TOOL_NAME,
  isReadOnlyBrowserCommand,
  parseBrowserControlCommand,
} from "@stll/api-contract/browser-control";
import type { BrowserControlCommand } from "@stll/api-contract/browser-control";
import { browserSiteGrantHost } from "@stll/api-contract/browser-site-grants";
import { isDeclinedChatToolCall } from "@stll/api-contract/chat";
import {
  localRunProposedPlan,
  localRunToolSubtitleText,
  localRunToolView,
} from "@stll/api-contract/chat-local-run-steps";
import {
  requiresPerCallChatApproval,
  USE_CONNECTOR_SECRET_TOOL_NAME,
} from "@stll/api-contract/chat-secret";
import {
  formatReadableInputValue,
  getCompleteConnectorInputRows,
  getReadableInputRows,
  humanizeIdentifier,
} from "@stll/api-contract/chat-tool-input-rows";
import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import {
  BrowserControlIcon,
  CheckIcon,
  GlobeIcon,
  PencilIcon,
  XIcon,
} from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { MatterIcon } from "@stll/ui/matter-icon";
import { ScrollArea } from "@stll/ui/scroll-area";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { MessageResponse } from "@/components/ai-elements/message";
import { AuthorNameRequiredDialog } from "@/components/chat/author-name-required-dialog";
import { useChatApproval } from "@/components/chat/chat-approval-context";
import {
  getApprovalToolName,
  getChatToolTitleKey,
  isApprovalOnceChatToolName,
  isExternalInputChatToolName,
  isExternalMcpToolName,
  isNonPersistentGrantChatToolName,
  isRegistryWriteSummaryToolName,
  isSuggestChangesApplyOutput,
  LOCAL_RUN_DETAIL_TITLE_KEYS,
} from "@/components/chat/chat-ui-tools";
import type {
  ApprovalToolName,
  ApprovalToolPart,
  ChatUITools,
  PendingApprovalToolPart,
  SuggestChangesApplyOutput,
} from "@/components/chat/chat-ui-tools";
import { findMcpConnectorIconHref } from "@/components/chat/mcp-connector-icon";
import {
  describeProposedDocxEdits,
  describeSuggestChangesApplyOutcome,
  hasAutomaticApproval,
} from "@/components/chat/tool-approval-card.logic";
import {
  buildRegistryWriteSummaryRows,
  findCachedReaderAnnotationRows,
  findReaderAnnotationMark,
  getReaderAnnotationEditTargetId,
} from "@/components/chat/tool-approval-summary";
import type { ReaderAnnotationMark } from "@/components/chat/tool-approval-summary";
import {
  getToolOutputError,
  ToolCallFailureDetails,
  toolFailureLabelKey,
} from "@/components/chat/tool-call-card";
import type { ToolCallAction } from "@/components/chat/tool-call-card";
import { readerAnnotationKeys } from "@/components/legal-reader/annotations/reader-annotations-query";
import { useProxiedIconSrc } from "@/components/proxied-icon";
import {
  BROWSER_APPROVAL_MODE,
  browserCommandSite,
  currentBrowserAutoApproval,
  recordBrowserSiteGrantApproval,
  setBrowserApprovalMode,
  useBrowserApprovalMode,
  useBrowserAutoApproval,
  useBrowserObservedPage,
} from "@/features/chat/browser-control/browser-approval-mode";
import {
  type BrowserApprovalDetail,
  getBrowserApprovalDetails,
} from "@/features/chat/browser-control/browser-approval-summary";
import { useBrowserSiteGrants } from "@/features/chat/browser-control/browser-site-grants";
import { useMountEffect } from "@/hooks/use-effect";
import { SIGNED_OUT_QUERY_OWNER } from "@/lib/account/queries";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { DocxEditRepresentation } from "@/lib/chat-edit-mode";
import { DOCX_EDIT_REPRESENTATION } from "@/lib/chat-edit-mode";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

type UpdateEntityFieldsInput = ChatUITools["update-entity-fields"]["input"];
type CreateWorkspaceDocumentInput =
  ChatUITools["create_matter_document"]["input"];

const getApprovalId = (part: ApprovalToolPart): string | null => {
  const { state } = part;
  switch (state) {
    case "awaiting-input":
    case "input-complete":
    case "input-streaming":
      return null;
    case "approval-requested":
    case "approval-responded":
    case "complete":
    case "error":
      return part.approval.id;
    default:
      state satisfies never;
      return panic("Unhandled approval tool state");
  }
};

const getApprovalPartInput = (part: ApprovalToolPart): unknown => part.input;

// -- Update summary (rich rendering) --

type UpdateSummaryProps = {
  input: UpdateEntityFieldsInput;
};

const UpdateSummary = ({ input }: UpdateSummaryProps) => {
  const t = useTranslations();
  const newVal = input.value;

  // The tool input carries per-turn chat refs (prop_N/ent_N), not stable
  // property/entity ids, so the property can no longer be resolved from the
  // React Query cache for name/option colors; the refs are shown as-is.
  const propName = input.propertyRef;

  let displayNew: string | null = null;
  if (Array.isArray(newVal)) {
    displayNew = newVal.join(", ");
  } else if (typeof newVal === "string") {
    displayNew = newVal;
  } else if (newVal !== null) {
    displayNew = JSON.stringify(newVal);
  }

  return (
    <div className="border-border/50 flex flex-col gap-1.5 border-t px-3 py-2">
      <code className="text-muted-foreground text-xs break-all">
        {input.entityRef}
      </code>
      {/* Property change */}
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">{propName}:</span>
        <span className="font-medium">{displayNew ?? t("common.empty")}</span>
      </div>
    </div>
  );
};

// -- Active DOCX edit summary --

type SuggestChangesSummaryProps = {
  operations: readonly unknown[];
  /** The active file the batch targets, when the surface knows it. */
  activeFileName?: string | undefined;
};

const SuggestChangesSummary = ({
  activeFileName,
  operations,
}: SuggestChangesSummaryProps) => {
  const t = useTranslations("chat.tool");
  const edits = describeProposedDocxEdits(operations);
  const previewEdits = edits.slice(0, 3);
  // Only describable operations can be "more"; the count line above still
  // reports every operation the model sent.
  const hiddenCount = edits.length - previewEdits.length;

  return (
    <div className="border-border/50 flex flex-col gap-1.5 border-t px-3 py-2 text-xs">
      {activeFileName && (
        <TruncatedText
          className="text-foreground-strong-muted font-medium"
          render={<div />}
        >
          {activeFileName}
        </TruncatedText>
      )}
      <div className="text-muted-foreground">
        {t("docxEditSummary", { count: operations.length })}
      </div>
      {previewEdits.map((edit, index) => (
        <div
          className="flex min-w-0 flex-col"
          // oxlint-disable-next-line react/no-array-index-key -- previewEdits is a read-only summary of an immutable AI tool-call input; never edited/reordered by the user.
          key={index}
        >
          <TruncatedText className="text-foreground-strong-muted">
            {edit.summary}
          </TruncatedText>
          {edit.text !== null && (
            <TruncatedText className="text-muted-foreground">
              {edit.text}
            </TruncatedText>
          )}
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="text-muted-foreground">
          {t("docxEditMore", { count: hiddenCount })}
        </div>
      )}
    </div>
  );
};

// -- Create workspace document summary --

type CreateWorkspaceDocumentSummaryProps = {
  input: CreateWorkspaceDocumentInput;
};

/**
 * Approval preview for `create_matter_document`: the model-supplied
 * title/filename and a truncated preview of the Markdown body, so the user
 * can see what will be written before approving a document write — rather
 * than the bare label the generic `ToolApprovalCard` falls back to.
 */
const CreateWorkspaceDocumentSummary = ({
  input,
}: CreateWorkspaceDocumentSummaryProps) => {
  const t = useTranslations();
  const trimmedTitle = input.title.trim();
  const fileName = `${trimmedTitle.length > 0 ? trimmedTitle : input.title}.docx`;
  const markdownPreview = formatReadableInputValue({
    emptyLabel: t("common.empty"),
    value: input.markdown,
  });

  return (
    <div className="border-border/50 flex flex-col gap-1.5 border-t px-3 py-2 text-xs">
      <TruncatedText
        className="text-foreground-strong-muted font-medium"
        render={<div />}
      >
        {fileName}
      </TruncatedText>
      <TruncatedText
        className="text-muted-foreground whitespace-pre-wrap"
        lines={4}
        render={<div />}
      >
        {markdownPreview}
      </TruncatedText>
    </div>
  );
};

// -- Automatic apply result (server-executed `suggest_changes`) --

type ChatToolTranslationKey = Parameters<
  ReturnType<typeof useTranslations<"chat.tool">>
>[0];

const REPRESENTATION_LABEL_KEY = {
  [DOCX_EDIT_REPRESENTATION.trackedChanges]:
    "suggestChangesRepresentationTrackedChanges",
  [DOCX_EDIT_REPRESENTATION.direct]: "suggestChangesRepresentationDirect",
} as const satisfies Record<DocxEditRepresentation, ChatToolTranslationKey>;

type SuggestChangesApplyResultProps = {
  output: SuggestChangesApplyOutput;
};

/**
 * Completed-call result for the server-executed `suggest_changes` variant
 * (the `auto` DOCX-edit mode): a concise "Applied N edits (M skipped)" line
 * on success, or -- when the tool returned the structured
 * `author_name_required` outcome instead of writing anything -- a message
 * plus a button that opens `AuthorNameRequiredDialog` and retries the turn
 * once a name is saved. The representation is read from the output, never
 * from the mutable composer preference, so a historical card stays right.
 */
const SuggestChangesApplyResult = ({
  output,
}: SuggestChangesApplyResultProps) => {
  const t = useTranslations("chat.tool");
  const { handleRetryAfterAuthorNameSet } = useChatApproval();
  const [nameDialogOpen, setNameDialogOpen] = useState(false);

  const outcome = describeSuggestChangesApplyOutcome(output);
  if (outcome === null) {
    return null;
  }

  if (outcome.kind === "applied") {
    return (
      <div className="border-border/50 text-muted-foreground border-t px-3 py-2 text-xs">
        {outcome.skippedCount > 0
          ? t("suggestChangesAppliedWithSkipped", {
              applied: outcome.appliedCount,
              skipped: outcome.skippedCount,
            })
          : t("suggestChangesApplied", {
              applied: outcome.appliedCount,
            })}{" "}
        · {t(REPRESENTATION_LABEL_KEY[outcome.representation])}
      </div>
    );
  }

  return (
    <div className="border-border/50 flex flex-col items-start gap-2 border-t px-3 py-2 text-xs">
      <p className="text-muted-foreground">
        {t("suggestChangesAuthorNameDialogDescription")}
      </p>
      <Button
        onClick={() => setNameDialogOpen(true)}
        size="xs"
        variant="outline"
      >
        {t("suggestChangesSetNameAction")}
      </Button>
      <AuthorNameRequiredDialog
        onNameSaved={() => {
          setNameDialogOpen(false);
          detached(
            Promise.resolve(handleRetryAfterAuthorNameSet?.()),
            "tool-approval-card.retry-after-author-name",
          );
        }}
        onOpenChange={setNameDialogOpen}
        open={nameDialogOpen}
      />
    </div>
  );
};

// -- Main card --

type ToolApprovalCardProps = {
  action?: ToolCallAction | undefined;
  /** Threaded through for the `suggest_changes` approval summary; see
   *  `ChatThreadMessagesProps.activeFileName`. */
  activeFileName?: string | undefined;
  /**
   * Whether the conversation still waits on this card. False once a later
   * user message superseded the turn (the server cancels the approval when it
   * accepts that message) or when the card belongs to an earlier turn; the
   * request then shows without controls and is never answered automatically.
   * Independent of `isTurnActive`: a card is awaited while its request
   * streams in and while its answer is being submitted, and neither once the
   * turn ended.
   */
  isAwaitingUser: boolean;
  /** Whether the turn this card belongs to is still running. */
  isTurnActive: boolean;
  part: ApprovalToolPart;
};

// Connector reads only decorate the card with an icon; the approval stays
// usable without them.
const useMcpApprovalIconHref = ({
  activeOrganizationId,
  name,
}: {
  activeOrganizationId: string;
  name: ApprovalToolName;
}): string | undefined => {
  const connectorSlug = getExternalMcpConnectorSlug(name);
  const mcpConnectorsQuery = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled: connectorSlug !== null,
  });
  const connectorsView = queryView(mcpConnectorsQuery);
  const availableConnectors =
    connectorsView.type === "items" ? connectorsView.items.connectors : [];
  return connectorSlug === null
    ? undefined
    : findMcpConnectorIconHref({
        connectorSlug,
        connectors: availableConnectors,
      });
};

/**
 * An approval-gated call whose input is still streaming. The request itself
 * arrives only once the input is complete; until then the card frame shows
 * what is being prepared, so the question the user is about to get is never
 * hidden behind the folded process steps.
 */
export const PendingToolApprovalCard = ({
  part,
}: {
  part: PendingApprovalToolPart;
}) => {
  const { activeOrganizationId } = useChatApproval();
  const t = useTranslations();
  const name = part.name;
  const mcpIconHref = useMcpApprovalIconHref({ activeOrganizationId, name });
  return (
    <div className="bg-muted/40 my-1 rounded-lg border border-transparent text-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <ToolApprovalLeadingIcon iconHref={mcpIconHref} toolName={name} />
        <span className="font-medium">
          {getExternalMcpProviderName(name) ?? t(getChatToolTitleKey(name))}
        </span>
        <Loader
          className="ms-auto size-3.5 shrink-0"
          label={t("common.preparing")}
          size="sm"
        />
      </div>
    </div>
  );
};

/**
 * How a browser command card relates to website approvals: the website its
 * command acts on or moves to (by exact origin), whether the reads mode or a
 * website approval may answer it, and the user's stored approvals. Like a
 * stored tool grant, a website approval the API did not confirm (`unconfirmed`)
 * answers nothing.
 */
const useBrowserCardApproval = ({
  browserCommand,
  unconfirmed,
}: {
  browserCommand: BrowserControlCommand | null;
  unconfirmed: boolean;
}) => {
  const sites = useBrowserSiteGrants(browserCommand !== null);
  const autoApproval = useBrowserAutoApproval({
    command: browserCommand,
    grantedOrigins: sites.grantedOrigins,
  });
  const observedPage = useBrowserObservedPage();
  const site =
    browserCommand === null
      ? null
      : browserCommandSite({ command: browserCommand, observedPage });
  const siteGrantOrigin =
    autoApproval.type === "site-grant" && !unconfirmed
      ? autoApproval.origin
      : null;
  return {
    /**
     * Whether the API still allows the site, read with a request of its own.
     * The card decides again once that read is back, on the approval state
     * of that moment: a re-paired controller, a failed command or a moved
     * tab in the meantime makes it ask. The site is kept with the call, and
     * its result is checked against it once the command ran.
     */
    confirmSiteGrant: async (toolCallId: string): Promise<boolean> => {
      if (siteGrantOrigin === null || browserCommand === null) {
        return false;
      }
      const fresh = await sites.readFresh();
      if (fresh === null) {
        return false;
      }
      const now = currentBrowserAutoApproval({
        command: browserCommand,
        grantedOrigins: fresh,
      });
      return (
        now.type === "site-grant" &&
        now.origin === siteGrantOrigin &&
        recordBrowserSiteGrantApproval(toolCallId, now.origin)
      );
    },
    isReadsAutoApproval: autoApproval.type === "reads-mode",
    /** The site the card offers to always allow: known, and not yet allowed. */
    offeredSite:
      site !== null && sites.canGrant && !sites.grantedOrigins.has(site)
        ? site
        : null,
    site,
    siteGrantOrigin,
    sites,
  };
};

/**
 * Allows this call and stores a website approval for `site`. The call is
 * allowed either way; a failed save only means the next call asks again.
 */
const AlwaysAllowSiteButton = ({
  allow,
  approve,
  site,
}: {
  allow: (origin: string) => Promise<void>;
  /** Answers the card; false when it was already answered. */
  approve: () => boolean;
  site: string;
}) => {
  const t = useTranslations();
  const allowSite = async () => {
    const stored = await Result.tryPromise(async () => await allow(site));
    if (stored.isErr()) {
      notifyUserError(stored.error, t("chat.approval.browser.allowSiteFailed"));
    }
  };
  return (
    <Button
      onClick={() => {
        if (approve()) {
          detached(allowSite(), "tool-approval-card.allow-browser-site");
        }
      }}
      size="xs"
      title={browserSiteGrantHost(site)}
      variant="outline"
    >
      {t("chat.approval.browser.alwaysAllowSite")}
    </Button>
  );
};

const AutomaticApprovalResponse = ({ respond }: { respond: () => void }) => {
  useMountEffect(() => {
    respond();
  });

  return null;
};

/**
 * The card's title. A step a coding agent asks about on the member's computer
 * is named by its kind, as its row names it.
 */
const approvalTitleKey = (name: ApprovalToolName, part: ApprovalToolPart) => {
  const detailKind =
    localRunToolView({
      name,
      input: getApprovalPartInput(part),
      output: part.output,
    })?.detailKind ?? null;
  return detailKind === null
    ? getChatToolTitleKey(name)
    : LOCAL_RUN_DETAIL_TITLE_KEYS[detailKind];
};

export const ToolApprovalCard = ({
  action,
  activeFileName,
  isAwaitingUser,
  isTurnActive,
  part,
}: ToolApprovalCardProps) => {
  const {
    activeOrganizationId,
    alwaysApprovedTools,
    conversationApprovedTools,
    confirmStoredApprovalGrant,
    blockedApprovalTools,
    handleAllowInConversation: onAllowInConversation,
    handleAlwaysAllow: onAlwaysAllow,
    handleApprove: onApprove,
    handleDeny: onDeny,
  } = useChatApproval();
  const t = useTranslations();
  const name = getApprovalToolName(part);
  const submittedApprovalIdRef = useRef<string | null>(null);
  const [responded, setResponded] = useState(false);
  // The approval a stored grant could not be confirmed for: that card asks.
  const [unconfirmedGrantApprovalId, setUnconfirmedGrantApprovalId] = useState<
    string | null
  >(null);

  const {
    canAllowInConversation,
    canAlwaysAllow,
    externalInput,
    externalMcpProviderName,
    isApprovalRequested,
    isApproved,
    isBlocked,
    isFailed,
    isProcessing,
    isDenied,
    label,
    showsExternalInput,
  } = getToolApprovalState({
    blockedApprovalTools,
    defaultLabel: t(approvalTitleKey(name, part)),
    name,
    part,
    isTurnActive,
    responded,
  });
  const mcpIconHref = useMcpApprovalIconHref({ activeOrganizationId, name });
  const rawErrorDetails = isFailed
    ? getToolOutputError(part.output)
    : undefined;
  const failureLabelKey = isFailed
    ? toolFailureLabelKey({ name, output: part.output, state: part.state })
    : undefined;

  const approvalId = isApprovalRequested ? getApprovalId(part) : null;
  const browserApprovalMode = useBrowserApprovalMode();
  const browserCommand =
    name === BROWSER_CONTROL_TOOL_NAME
      ? parseBrowserControlCommand(getApprovalPartInput(part))
      : null;
  const browserApproval = useBrowserCardApproval({
    browserCommand,
    unconfirmed: approvalId === unconfirmedGrantApprovalId,
  });
  // A stored grant or website approval answers a card only once the API
  // confirms it still holds; opted-in browser page reads need no grant.
  const isGrantAutoApproval =
    approvalId !== unconfirmedGrantApprovalId &&
    hasAutomaticApproval({
      alwaysApprovedTools,
      canAlwaysAllow,
      conversationApprovedTools,
      name,
    });
  const confirmAutoApproval =
    browserApproval.siteGrantOrigin === null
      ? async () => await confirmStoredApprovalGrant(name)
      : async () => await browserApproval.confirmSiteGrant(part.id);
  const shouldAutoApprove =
    !isBlocked &&
    !requiresPerCallChatApproval(name) &&
    (isGrantAutoApproval ||
      browserApproval.isReadsAutoApproval ||
      browserApproval.siteGrantOrigin !== null);
  const automaticResponse =
    approvalId === null
      ? null
      : {
          key: `${approvalId}:${isBlocked ? "deny" : "approve"}`,
          respond: () => {
            setResponded(true);
            if (isBlocked) {
              onDeny(approvalId);
            } else if (browserApproval.isReadsAutoApproval) {
              onApprove(approvalId, name);
            } else if (shouldAutoApprove) {
              const answerIfConfirmed = async () => {
                if (await confirmAutoApproval()) {
                  await onApprove(approvalId, name);
                  return;
                }
                setUnconfirmedGrantApprovalId(approvalId);
                setResponded(false);
              };
              detached(
                answerIfConfirmed(),
                "tool-approval-card.confirm-stored-grant",
              );
            }
          },
          // A card the user already answered is not answered again.
          shouldRespond:
            isAwaitingUser && !responded && (isBlocked || shouldAutoApprove),
        };
  // Answered cards stop asking, even while the answer waits for the rest of
  // a batch.
  const asksForDecision =
    isAwaitingUser && isApprovalRequested && !responded && !isProcessing;
  const isAwaitingDecision = asksForDecision && !isBlocked;
  const beginManualResponse = (id: string): boolean => {
    if (submittedApprovalIdRef.current === id) {
      return false;
    }

    submittedApprovalIdRef.current = id;
    setResponded(true);
    return true;
  };

  return (
    <div
      className={cn(
        "my-1 rounded-lg border text-sm",
        asksForDecision
          ? "border-border bg-muted/30"
          : "bg-muted/40 border-transparent",
      )}
    >
      {automaticResponse?.shouldRespond && (
        <AutomaticApprovalResponse
          key={automaticResponse.key}
          respond={automaticResponse.respond}
        />
      )}
      {/* Header: icon + label + status */}
      <div className="flex items-center gap-2 px-3 py-2">
        <ToolApprovalLeadingIcon iconHref={mcpIconHref} toolName={name} />
        <span className="font-medium">{label}</span>
        {isProcessing && (
          <Loader
            className="ms-auto size-3.5 shrink-0"
            label={t("common.running")}
            size="sm"
          />
        )}
        {isApproved && (
          <CheckIcon
            aria-label={t("chat.approval.allowed")}
            className="text-success ms-auto size-3.5 shrink-0"
            role="img"
          />
        )}
        {isDenied && (
          <XIcon
            aria-label={t("chat.approval.denied")}
            className="text-destructive ms-auto size-3.5 shrink-0"
            role="img"
          />
        )}
        {isFailed && (
          <XIcon
            aria-hidden
            className="text-destructive ms-auto size-3.5 shrink-0"
          />
        )}
        {action !== undefined && (
          <Button
            className="-me-1 shrink-0"
            onClick={action.onClick}
            size="xs"
            type="button"
            variant="ghost"
          >
            {action.label}
          </Button>
        )}
      </div>

      <ToolApprovalSummary
        activeFileName={activeFileName}
        browserSite={browserApproval.site}
        externalInput={showsExternalInput ? externalInput : undefined}
        isAwaitingDecision={isAwaitingDecision}
        part={part}
        providerName={externalMcpProviderName ?? label}
      />
      {failureLabelKey !== undefined && (
        <div className="px-3">
          <ToolCallFailureDetails
            errorMessage={t(failureLabelKey)}
            rawErrorDetails={rawErrorDetails}
          />
        </div>
      )}
      {isAwaitingDecision &&
        browserCommand !== null &&
        browserApprovalMode === BROWSER_APPROVAL_MODE.autoApproveReads && (
          <BrowserApprovalModeNotice
            onReset={() =>
              setBrowserApprovalMode(BROWSER_APPROVAL_MODE.askEveryTime)
            }
          />
        )}

      {approvalId && asksForDecision && !isBlocked && (
        <div className="border-border/50 flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <Button
            autoFocus
            onClick={() => {
              if (!beginManualResponse(approvalId)) {
                return;
              }
              onApprove(approvalId, name);
            }}
            size="xs"
          >
            {t("chat.approval.allowOnce")}
          </Button>
          {browserApproval.offeredSite !== null && (
            <AlwaysAllowSiteButton
              allow={browserApproval.sites.allow}
              approve={() => {
                if (!beginManualResponse(approvalId)) {
                  return false;
                }
                onApprove(approvalId, name);
                return true;
              }}
              site={browserApproval.offeredSite}
            />
          )}
          {browserCommand !== null &&
            isReadOnlyBrowserCommand(browserCommand) &&
            browserApprovalMode === BROWSER_APPROVAL_MODE.askEveryTime && (
              <Button
                onClick={() => {
                  if (!beginManualResponse(approvalId)) {
                    return;
                  }
                  setBrowserApprovalMode(
                    BROWSER_APPROVAL_MODE.autoApproveReads,
                  );
                  onApprove(approvalId, name);
                }}
                size="xs"
                variant="outline"
              >
                {t("chat.approval.browser.autoApproveReads")}
              </Button>
            )}
          {canAllowInConversation && (
            <Button
              onClick={() => {
                if (!beginManualResponse(approvalId)) {
                  return;
                }
                onAllowInConversation(approvalId, name);
              }}
              size="xs"
              variant="outline"
            >
              {t("chat.approval.allowInConversation")}
            </Button>
          )}
          {canAlwaysAllow && (
            <Button
              onClick={() => {
                if (!beginManualResponse(approvalId)) {
                  return;
                }
                onAlwaysAllow(approvalId, name);
              }}
              size="xs"
              variant="outline"
            >
              {t("chat.approval.alwaysAllow")}
            </Button>
          )}
          <Button
            className="ms-auto"
            onClick={() => {
              if (!beginManualResponse(approvalId)) {
                return;
              }
              onDeny(approvalId);
            }}
            size="xs"
            variant="ghost"
          >
            {t("chat.approval.deny")}
          </Button>
        </div>
      )}
    </div>
  );
};

const ToolApprovalSummary = ({
  activeFileName,
  browserSite,
  externalInput,
  isAwaitingDecision,
  part,
  providerName,
}: {
  activeFileName: string | undefined;
  browserSite: string | null;
  externalInput: unknown;
  isAwaitingDecision: boolean;
  part: ApprovalToolPart;
  providerName: string;
}) => {
  if (part.state === "input-streaming") {
    return null;
  }

  const name = getApprovalToolName(part);
  const input = getApprovalPartInput(part);
  const proposedPlan = localRunProposedPlan({ name, input });
  return (
    <>
      {proposedPlan !== null && <LocalRunPlanSummary plan={proposedPlan} />}
      {part.name === "update-entity-fields" && part.input !== undefined && (
        <UpdateSummary input={part.input} />
      )}
      {part.name === "suggest_changes" && part.input !== undefined && (
        <SuggestChangesSummary
          activeFileName={activeFileName}
          operations={part.input.operations}
        />
      )}
      {part.name === "suggest_changes" &&
        part.state === "complete" &&
        part.output !== undefined &&
        isSuggestChangesApplyOutput(part.output) && (
          <SuggestChangesApplyResult output={part.output} />
        )}
      {part.name === "create_matter_document" && part.input !== undefined && (
        <CreateWorkspaceDocumentSummary input={part.input} />
      )}
      {part.name === "search-all-past-chats" && part.input !== undefined && (
        <SearchAllPastChatsSummary
          isAwaitingDecision={part.state === "approval-requested"}
          query={part.input.query}
        />
      )}
      {name === BROWSER_CONTROL_TOOL_NAME && input !== undefined && (
        <BrowserControlInputSummary
          input={input}
          isAwaitingDecision={isAwaitingDecision}
          site={browserSite}
        />
      )}
      {externalInput !== undefined && (
        <ExternalMcpInputSummary
          input={externalInput}
          isAwaitingDecision={isAwaitingDecision}
          providerName={providerName}
          toolName={name}
        />
      )}
      {isRegistryWriteSummaryToolName(name) && input !== undefined && (
        <RegistryWriteSummary input={input} toolName={name} />
      )}
      <LocalRunToolSummary input={input} name={name} />
    </>
  );
};

/**
 * What a coding agent on the member's computer asks to do, as its step row
 * names it (a command, file names, a web search's query), so the member
 * approves the step itself rather than a tool name. Nothing for any other
 * tool.
 */
const LocalRunToolSummary = ({
  input,
  name,
}: {
  input: unknown;
  name: string;
}) => {
  const t = useTranslations();
  const view = localRunToolView({ name, input, output: undefined });
  const subtitle =
    view === null
      ? null
      : localRunToolSubtitleText(view.subtitle, {
          patternInPath: (values) => t("chat.toolCall.patternInPath", values),
          commandExited: (values) => t("chat.toolCall.commandExited", values),
        });
  if (subtitle === null || subtitle === "") {
    return null;
  }
  return (
    <div className="border-border/50 border-t px-3 py-2">
      <p className="text-xs wrap-break-word">{subtitle}</p>
    </div>
  );
};

/**
 * The plan a coding agent proposes before it acts, read whole so the member
 * knows what approving it lets the agent do.
 */
const LocalRunPlanSummary = ({ plan }: { plan: string }) => (
  <div className="border-border/50 border-t">
    <ScrollArea axis="vertical" className="max-h-96">
      <div className="px-3 py-2 text-sm">
        <MessageResponse mode="static">{plan}</MessageResponse>
      </div>
    </ScrollArea>
  </div>
);

type SummaryMatter = { color: string | null; id: string; name: string };

/**
 * The org's matters keyed by id, for turning a matter id in a write tool's
 * input into the matter itself. The navigation list is already in flight on
 * every chat surface (`chat-mention-providers`, the sidebar), so this is a
 * cache read rather than a fetch; a miss (matter deleted, or outside the
 * user's access) simply leaves the row's value as it came.
 */
const useMattersById = (): ReadonlyMap<string, SummaryMatter> => {
  const { activeOrganizationId } = useChatApproval();
  const user = useMaybeAuthenticatedUser();
  const dataQuery = useQuery({
    ...workspacesNavigationOptions({
      organizationId: activeOrganizationId,
      userId: user?.id ?? SIGNED_OUT_QUERY_OWNER,
    }),
    enabled: user !== null,
  });
  const dataView = queryView(dataQuery);
  useQueryViewError(dataView, "useMattersById:query");
  const data = dataView.type === "items" ? dataView.items : undefined;
  const byId = new Map<string, SummaryMatter>();
  if (!data) {
    return byId;
  }
  for (const workspace of data.workspaces) {
    byId.set(workspace.id, {
      color: workspace.color,
      id: workspace.id,
      name: workspace.name,
    });
  }
  return byId;
};

/**
 * The mark an annotation edit or delete names, read from whichever reader has
 * it loaded, so the approver sees the words rather than an id. The chat that
 * runs these tools is bound to that reader, so a miss (the reader closed, or a
 * guest's marks, which live outside the query cache) is rare and falls back to
 * the generic summary. Subscribed to the cache so a reader list that arrives
 * after the card renders still fills it in.
 */
const useCachedReaderAnnotationMark = (
  annotationId: string | null,
): ReaderAnnotationMark | null => {
  const queryClient = useQueryClient();
  const rows = useSyncExternalStore(
    (onStoreChange) => queryClient.getQueryCache().subscribe(onStoreChange),
    () =>
      annotationId === null
        ? undefined
        : findCachedReaderAnnotationRows({
            annotationId,
            cachedLists: queryClient
              .getQueriesData({ queryKey: readerAnnotationKeys.all })
              .map(([, data]) => data),
          }),
  );
  if (annotationId === null || rows === undefined) {
    return null;
  }
  return findReaderAnnotationMark({ annotationId, rows });
};

const getToolApprovalState = ({
  blockedApprovalTools,
  defaultLabel,
  name,
  isTurnActive,
  part,
  responded,
}: {
  blockedApprovalTools: ReturnType<
    typeof useChatApproval
  >["blockedApprovalTools"];
  defaultLabel: string;
  name: ApprovalToolName;
  part: ApprovalToolPart;
  responded: boolean;
  isTurnActive: boolean;
}) => {
  const isApprovalRequested = part.state === "approval-requested";
  const isApprovalResponded = part.state === "approval-responded";
  // The server-executed `suggest_changes` variant reports a missing author
  // name as a structured outcome rather than a thrown error; the card shows
  // it as a decline with an inline remedy.
  const isStructuredEditFailure =
    part.name === "suggest_changes" &&
    part.state === "complete" &&
    part.output !== undefined &&
    isSuggestChangesApplyOutput(part.output) &&
    !part.output.success;
  // A declined call is stored settled as an error; it is still a decline.
  const isDenied = isStructuredEditFailure || isDeclinedChatToolCall(part);
  const isApproved =
    part.state === "complete" && part.output !== undefined && !isDenied;
  const isBlocked = blockedApprovalTools?.has(name) ?? false;
  const isExternalMcpApproval = isExternalMcpToolName(name);
  // A valid browser command renders its own structured summary; one that
  // fails the schema falls back to the generic rows so the user still sees
  // what the model sent.
  const showsExternalInput =
    (name !== BROWSER_CONTROL_TOOL_NAME ||
      parseBrowserControlCommand(getApprovalPartInput(part)) === null) &&
    (isExternalMcpApproval || isExternalInputChatToolName(name));
  // High-impact writes may only be approved once or denied: no persistent
  // grant can auto-approve a later call.
  const isApprovalOnce = isApprovalOnceChatToolName(name);
  const canAllowInConversation =
    !requiresPerCallChatApproval(name) &&
    !isApprovalOnce &&
    !isNonPersistentGrantChatToolName(name);
  const externalMcpProviderName = getExternalMcpProviderName(name);

  return {
    canAllowInConversation,
    canAlwaysAllow: canAllowInConversation,
    externalInput:
      showsExternalInput && part.state !== "input-streaming"
        ? getApprovalPartInput(part)
        : undefined,
    externalMcpProviderName,
    isApprovalRequested,
    isApprovalResponded,
    isApproved,
    isBlocked,
    isDenied,
    // Approved, then the tool threw (or its stream died): neither allowed
    // nor denied, so the card says so instead of showing no status.
    isFailed: part.state === "error" && !isDenied,
    isExternalMcpApproval,
    // Working only while the turn runs: a denied call runs nothing, and an
    // answer inside a batch waits, idle, for the rest of the batch.
    isProcessing:
      isTurnActive &&
      !isDenied &&
      (isApprovalResponded || (responded && isApprovalRequested)),
    isStructuredEditFailure,
    label: externalMcpProviderName ?? defaultLabel,
    showsExternalInput,
  };
};

/**
 * One approval-summary row. A value that is a matter id renders as the matter:
 * its name beside the layers glyph in the matter's own colour, the same way it
 * reads everywhere else in the app. The id itself is what the user least needs
 * to see when deciding whether to allow a write.
 */
const RegistryWriteSummaryRow = ({
  label,
  matter,
  value,
}: {
  label: string;
  matter: SummaryMatter | undefined;
  value: string;
}) => (
  <DetailsItem label={matter ? stripIdSuffix(label) : label}>
    {matter ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <MatterIcon
          className="size-3.5 shrink-0"
          matter={{ color: matter.color, id: matter.id }}
        />
        <TruncatedText>{matter.name}</TruncatedText>
      </span>
    ) : (
      value
    )}
  </DetailsItem>
);

/** "Matter id" -> "Matter": the id is no longer what the row shows. A single
 *  space suffices because `humanizeIdentifier` has already collapsed runs. */
const stripIdSuffix = (label: string): string =>
  label.replace(/ id$/iu, "") || label;

const RegistryWriteSummary = ({
  input,
  toolName,
}: {
  input: unknown;
  toolName: string;
}) => {
  const t = useTranslations();
  const mattersById = useMattersById();
  const readerAnnotationMark = useCachedReaderAnnotationMark(
    getReaderAnnotationEditTargetId({ input, toolName }),
  );
  const rows = buildRegistryWriteSummaryRows({
    documentLabel: t("common.document"),
    emptyLabel: t("common.empty"),
    input,
    readerAnnotation:
      readerAnnotationMark === null
        ? null
        : {
            labels: {
              commentText: t("legalReader.annotations.commentText"),
              passage: {
                comment: t("legalReader.annotations.commentedPassage"),
                highlight: t("legalReader.annotations.highlightedPassage"),
              },
            },
            mark: readerAnnotationMark,
          },
    toolName,
    uploadPlaceholder: t("chat.approval.uploadedDocumentPlaceholder"),
  });

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="border-border/50 border-t px-3 py-2">
      <DetailsGrid variant="list">
        {rows.map((row) => (
          <RegistryWriteSummaryRow
            key={row.key}
            label={row.label}
            matter={mattersById.get(row.value)}
            value={row.value}
          />
        ))}
      </DetailsGrid>
    </div>
  );
};

/** Until approved, only chats about this chat's matters were searched. */
const SearchAllPastChatsSummary = ({
  isAwaitingDecision,
  query,
}: {
  isAwaitingDecision: boolean;
  query: string;
}) => {
  const t = useTranslations();
  return (
    <div className="border-border/50 space-y-1 border-t px-3 py-2">
      {isAwaitingDecision && (
        <>
          <p className="text-sm font-medium">
            {t("chat.approval.searchAllPastChatsQuestion")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("chat.approval.searchAllPastChatsDescription")}
          </p>
        </>
      )}
      <p className="text-xs wrap-break-word">{query}</p>
    </div>
  );
};

const ExternalMcpInputSummary = ({
  input,
  isAwaitingDecision,
  providerName,
  toolName,
}: {
  input: unknown;
  isAwaitingDecision: boolean;
  providerName: string;
  toolName: ApprovalToolName;
}) => {
  const t = useTranslations();
  const rowOptions = {
    emptyLabel: t("common.empty"),
    input,
    requestLabel: t("chat.toolCall.input"),
  };
  const rows =
    toolName === USE_CONNECTOR_SECRET_TOOL_NAME
      ? getCompleteConnectorInputRows(rowOptions)
      : getReadableInputRows(rowOptions);

  return (
    <div className="border-border/50 space-y-2 border-t px-3 py-2">
      {isAwaitingDecision && (
        <div>
          <p className="text-sm font-medium">
            {t("chat.approval.externalMcpQuestion", { provider: providerName })}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t("chat.approval.externalMcpDescription")}
          </p>
        </div>
      )}
      <div className="text-xs">
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="plain" />}>
            <span className="text-muted-foreground hover:text-foreground">
              {t("common.showDetails")}
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="bg-background/60 mt-2 rounded-md border p-2">
              <DetailsGrid variant="list">
                {rows.map((row) => (
                  <DetailsItem key={row.key} label={row.label}>
                    {row.value}
                  </DetailsItem>
                ))}
              </DetailsGrid>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </div>
  );
};

const browserActionTranslationKey = (command: BrowserControlCommand) => {
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.click:
      return "chat.approval.browser.actions.click";
    case BROWSER_CONTROL_ACTION.fill:
      return "chat.approval.browser.actions.fill";
    case BROWSER_CONTROL_ACTION.goBack:
      return "common.goBack";
    case BROWSER_CONTROL_ACTION.open:
      return command.newTab === true
        ? "chat.approval.browser.actions.openNewTab"
        : "chat.approval.browser.actions.open";
    case BROWSER_CONTROL_ACTION.pressKey:
      return "chat.approval.browser.actions.pressKey";
    case BROWSER_CONTROL_ACTION.select:
      return "chat.approval.browser.actions.select";
    case BROWSER_CONTROL_ACTION.snapshot:
      return (command.textOffset ?? 0) > 0
        ? "chat.approval.browser.actions.snapshotContinue"
        : "chat.approval.browser.actions.snapshot";
    case BROWSER_CONTROL_ACTION.switchTab:
      return "chat.approval.browser.actions.switchTab";
    default:
      command satisfies never;
      return panic("Unhandled browser-control action");
  }
};

const BrowserApprovalModeNotice = ({ onReset }: { onReset: () => void }) => {
  const t = useTranslations();
  return (
    <div className="border-border/50 text-muted-foreground flex items-center gap-2 border-t px-3 py-1.5 text-xs">
      <span>{t("chat.approval.browser.modeReads")}</span>
      <Button className="ms-auto" onClick={onReset} size="xs" variant="ghost">
        {t("chat.approval.browser.askAgain")}
      </Button>
    </div>
  );
};

const BrowserControlInputSummary = ({
  input,
  isAwaitingDecision,
  site,
}: {
  input: unknown;
  isAwaitingDecision: boolean;
  /** The website the command acts on or moves to, by origin. */
  site: string | null;
}) => {
  const t = useTranslations();
  const command = parseBrowserControlCommand(input);
  if (!command) {
    return null;
  }

  const labelForDetail = ({ type: detailType }: BrowserApprovalDetail) => {
    switch (detailType) {
      case "context":
        return t("chat.approval.browser.within");
      case "key":
        return t("common.key");
      case "link":
        return t("search.kinds.link");
      case "target":
        return t("common.target");
      case "value":
        return t("common.value");
      case "website":
        return t("common.website");
      default:
        detailType satisfies never;
        return panic("Unhandled browser approval detail");
    }
  };
  const details = getBrowserApprovalDetails(command);
  // A read or going back names no address of its own; while it asks, the
  // card names the website the tab is on, the one "always allow" covers.
  const pageSite =
    isAwaitingDecision &&
    site !== null &&
    !details.some(({ type }) => type === "website")
      ? [{ label: t("common.website"), value: browserSiteGrantHost(site) }]
      : [];
  const rows = [
    {
      label: t("common.action"),
      value: t(browserActionTranslationKey(command)),
    },
    ...details.map((detail) => ({
      label: labelForDetail(detail),
      value: detail.value,
    })),
    ...pageSite,
  ];

  return (
    <div className="border-border/50 space-y-2 border-t px-3 py-2">
      {isAwaitingDecision && (
        <div>
          <p className="text-sm font-medium">
            {t("chat.approval.browser.question")}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t("chat.approval.browser.description")}{" "}
            {/* The browser receives the values below as they are, whatever
                the send mode: anonymized mode covers only what the model
                sees. Stated on every pending card, since the mode can change
                while it waits. */}
            <strong className="text-foreground font-medium">
              {t("chat.approval.browser.realValues")}
            </strong>
          </p>
        </div>
      )}
      <div className="bg-background/60 rounded-md border p-2">
        <DetailsGrid variant="list">
          {rows.map((row) => (
            <DetailsItem key={row.label} label={row.label}>
              <span dir="auto">{row.value}</span>
            </DetailsItem>
          ))}
        </DetailsGrid>
      </div>
    </div>
  );
};

const getExternalMcpProviderName = (
  toolName: ApprovalToolName,
): string | null => {
  const connectorSlug = getExternalMcpConnectorSlug(toolName);
  return connectorSlug ? humanizeIdentifier(connectorSlug) : null;
};

const getExternalMcpConnectorSlug = (
  toolName: ApprovalToolName,
): string | null => {
  if (!isExternalMcpToolName(toolName)) {
    return null;
  }

  const [, connectorSlug] = toolName.split("__");
  return connectorSlug ?? null;
};

const ToolApprovalLeadingIcon = ({
  iconHref,
  toolName,
}: {
  iconHref?: string | undefined;
  toolName?: ApprovalToolName | undefined;
}) => {
  const proxiedIconSrc = useProxiedIconSrc(iconHref);
  if (proxiedIconSrc) {
    return (
      <span className="bg-background flex size-4 shrink-0 items-center justify-center rounded-sm border">
        <img
          alt=""
          className="size-3 rounded-xs object-contain"
          height={12}
          src={proxiedIconSrc}
          width={12}
        />
      </span>
    );
  }

  if (toolName === "web_search" || toolName === "fetch_url") {
    return <GlobeIcon className="text-muted-foreground size-4 shrink-0" />;
  }

  if (toolName === BROWSER_CONTROL_TOOL_NAME) {
    return (
      <BrowserControlIcon className="text-muted-foreground size-4 shrink-0" />
    );
  }

  return <PencilIcon className="text-muted-foreground size-4 shrink-0" />;
};
