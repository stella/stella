import { useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import {
  CheckIcon,
  GlobeIcon,
  LoaderIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
import { AuthorNameRequiredDialog } from "@/components/chat/author-name-required-dialog";
import { useChatApproval } from "@/components/chat/chat-approval-context";
import {
  getChatToolTitleKey,
  getApprovalToolName,
  isApprovalOnceChatToolName,
  isExternalInputChatToolName,
  isExternalMcpToolName,
  isNonPersistentGrantChatToolName,
  isPublicOfficialChatToolName,
  isRegistryWriteSummaryToolName,
} from "@/components/chat/chat-ui-tools";
import type {
  ApprovalToolName,
  ApprovalToolPart,
  ChatUITools,
} from "@/components/chat/chat-ui-tools";
import { SpawnSubagentsSubtaskList } from "@/components/chat/spawn-subagents-card";
import {
  describeEditWorkspaceDocumentOutcome,
  hasAutomaticApproval,
} from "@/components/chat/tool-approval-card.logic";
import {
  buildRegistryWriteSummaryRows,
  formatReadableInputValue,
  getReadableInputRows,
  humanizeIdentifier,
} from "@/components/chat/tool-approval-summary";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterIcon } from "@/components/matter-icon";
import { useMountEffect } from "@/hooks/use-effect";
import type { DocxEditRepresentation } from "@/lib/chat-edit-mode";
import { DOCX_EDIT_REPRESENTATION } from "@/lib/chat-edit-mode";
import { detached } from "@/lib/detached";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { sanitizeHref } from "@/lib/sanitize-href";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

type UpdateEntityFieldsInput = ChatUITools["update-entity-fields"]["input"];
type ActiveDocxEditInput = ChatUITools["apply-active-docx-edits"]["input"];
type CreateWorkspaceDocumentInput =
  ChatUITools["create_workspace_document"]["input"];
type EditWorkspaceDocumentInput =
  ChatUITools["edit_workspace_document"]["input"];
type EditWorkspaceDocumentOutput =
  ChatUITools["edit_workspace_document"]["output"];

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

type ActiveDocxEditSummaryProps = {
  input: ActiveDocxEditInput;
};

/** The block an operation anchors to; range ops carry it on the handle. */
const docxOperationAnchorBlockId = (
  operation: ActiveDocxEditInput["operations"][number],
): string =>
  operation.type === "replaceRange" || operation.type === "commentOnRange"
    ? operation.range.blockId
    : operation.blockId;

const ActiveDocxEditSummary = ({ input }: ActiveDocxEditSummaryProps) => {
  const t = useTranslations("chat.tool");
  const previewOperations = input.operations.slice(0, 3);
  const hiddenCount = input.operations.length - previewOperations.length;

  const renderOperationSummary = (
    operation: ActiveDocxEditInput["operations"][number],
  ) => {
    switch (operation.type) {
      case "replaceInBlock":
        return t("docxReplaceSummary", {
          find: operation.find,
          replace: operation.replace,
        });
      case "replaceBlock":
        return t("docxReplaceBlockSummary", {
          blockId: operation.blockId,
        });
      // Range-addressed ops reuse the block-level summaries: the range
      // handle anchors to one block, and the card only needs to say
      // which block is touched.
      case "replaceRange":
        return t("docxReplaceBlockSummary", {
          blockId: operation.range.blockId,
        });
      case "commentOnRange":
        return t("docxCommentSummary", {
          blockId: operation.range.blockId,
        });
      case "insertAfterBlock":
        return t("docxInsertAfterSummary", {
          blockId: operation.blockId,
        });
      case "insertBeforeBlock":
        return t("docxInsertBeforeSummary", {
          blockId: operation.blockId,
        });
      case "deleteBlock":
        return t("docxDeleteSummary", {
          blockId: operation.blockId,
        });
      case "commentOnBlock":
        return t("docxCommentSummary", {
          blockId: operation.blockId,
        });
      case "insertSignatureTable":
        return t("docxSignatureTableSummary", {
          blockId: operation.blockId,
        });
      case "insertTableRow":
        return t("docxInsertTableRowSummary", {
          blockId: operation.blockId,
        });
      case "deleteTableRow":
        return t("docxDeleteTableRowSummary", {
          blockId: operation.blockId,
        });
      case "insertTableColumn":
        return t("docxInsertTableColumnSummary", {
          blockId: operation.blockId,
        });
      case "deleteTableColumn":
        return t("docxDeleteTableColumnSummary", {
          blockId: operation.blockId,
        });
      case "mergeTableCells":
        return t("docxMergeTableCellsSummary", {
          blockId: operation.blockId,
        });
      case "splitTableCell":
        return t("docxSplitTableCellSummary", {
          blockId: operation.blockId,
        });
      default:
        operation satisfies never;
        return panic("Unsupported DOCX edit operation");
    }
  };

  return (
    <div className="border-border/50 flex flex-col gap-1.5 border-t px-3 py-2 text-xs">
      <div className="text-muted-foreground">
        {t("docxEditSummary", { count: input.operations.length })}
      </div>
      {previewOperations.map((operation, index) => (
        <div
          className="text-foreground-strong-muted truncate"
          // eslint-disable-next-line react/no-array-index-key -- previewOperations is a read-only summary of an immutable AI tool-call input; never edited/reordered by the user.
          key={`${docxOperationAnchorBlockId(operation)}-${operation.type}-${index}`}
        >
          {renderOperationSummary(operation)}
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
 * Approval preview for `create_workspace_document`: the model-supplied
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
      <div className="text-foreground-strong-muted truncate font-medium">
        {fileName}
      </div>
      <div className="text-muted-foreground line-clamp-4 whitespace-pre-wrap">
        {markdownPreview}
      </div>
    </div>
  );
};

// -- Edit workspace document (auto DOCX edit) summary --

type EditWorkspaceDocumentSummaryProps = {
  input: EditWorkspaceDocumentInput;
  activeFileName?: string | undefined;
};

type ChatToolTranslationKey = Parameters<
  ReturnType<typeof useTranslations<"chat.tool">>
>[0];

const REPRESENTATION_LABEL_KEY = {
  [DOCX_EDIT_REPRESENTATION.trackedChanges]:
    "editWorkspaceDocumentRepresentationTrackedChanges",
  [DOCX_EDIT_REPRESENTATION.direct]:
    "editWorkspaceDocumentRepresentationDirect",
} as const satisfies Record<DocxEditRepresentation, ChatToolTranslationKey>;

/**
 * Approval preview for `edit_workspace_document` (the `auto` DOCX-edit
 * tool): the target document (from the file overlay's active file) and a
 * readable operation count. The representation is intentionally omitted
 * before approval because it is session metadata, not tool input; reading the
 * mutable current composer preference could mislabel a pending or historical
 * call. Completed cards render the actual representation from tool output.
 */
const EditWorkspaceDocumentSummary = ({
  input,
  activeFileName,
}: EditWorkspaceDocumentSummaryProps) => {
  const t = useTranslations("chat.tool");

  return (
    <div className="border-border/50 flex flex-col gap-1.5 border-t px-3 py-2 text-xs">
      {activeFileName && (
        <div className="text-foreground-strong-muted truncate font-medium">
          {activeFileName}
        </div>
      )}
      <div className="text-muted-foreground">
        {t("editWorkspaceDocumentSummary", {
          count: input.operations.length,
        })}
      </div>
    </div>
  );
};

type EditWorkspaceDocumentResultProps = {
  output: EditWorkspaceDocumentOutput;
};

/**
 * Completed-call result for `edit_workspace_document`: a concise
 * "Applied N edits (M skipped)" line on success, or -- when the tool
 * returned the structured `author_name_required` outcome instead of
 * writing anything -- a message plus a button that opens
 * `AuthorNameRequiredDialog` and retries the turn once a name is saved.
 */
const EditWorkspaceDocumentResult = ({
  output,
}: EditWorkspaceDocumentResultProps) => {
  const t = useTranslations("chat.tool");
  const { handleRetryAfterAuthorNameSet } = useChatApproval();
  const [nameDialogOpen, setNameDialogOpen] = useState(false);

  const outcome = describeEditWorkspaceDocumentOutcome(output);
  if (outcome === null) {
    return null;
  }

  if (outcome.kind === "applied") {
    return (
      <div className="border-border/50 text-muted-foreground border-t px-3 py-2 text-xs">
        {outcome.skippedCount > 0
          ? t("editWorkspaceDocumentAppliedWithSkipped", {
              applied: outcome.appliedCount,
              skipped: outcome.skippedCount,
            })
          : t("editWorkspaceDocumentApplied", {
              applied: outcome.appliedCount,
            })}{" "}
        · {t(REPRESENTATION_LABEL_KEY[outcome.representation])}
      </div>
    );
  }

  return (
    <div className="border-border/50 flex flex-col items-start gap-2 border-t px-3 py-2 text-xs">
      <p className="text-muted-foreground">
        {t("editWorkspaceDocumentAuthorNameDialogDescription")}
      </p>
      <Button
        onClick={() => setNameDialogOpen(true)}
        size="xs"
        variant="outline"
      >
        {t("editWorkspaceDocumentSetNameAction")}
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
  /** Threaded through for `edit_workspace_document`'s summary; see
   *  `ChatThreadMessagesProps.activeFileName`. */
  activeFileName?: string | undefined;
  part: ApprovalToolPart;
};

const AutomaticApprovalResponse = ({ respond }: { respond: () => void }) => {
  useMountEffect(() => {
    respond();
  });

  return null;
};

export const ToolApprovalCard = ({
  activeFileName,
  part,
}: ToolApprovalCardProps) => {
  const {
    activeOrganizationId,
    alwaysApprovedTools,
    conversationApprovedTools,
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

  const {
    canAllowInConversation,
    canAlwaysAllow,
    externalInput,
    externalMcpConnectorSlug,
    externalMcpProviderName,
    isApprovalRequested,
    isApproved,
    isBlocked,
    isDocxEditBatch,
    isProcessing,
    isPublicOfficialApproval,
    isDenied,
    label,
    showsExternalInput,
  } = getToolApprovalState({
    blockedApprovalTools,
    defaultLabel: t(getChatToolTitleKey(name)),
    name,
    part,
    responded,
  });
  const { data: mcpConnectorsData } = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled: externalMcpConnectorSlug !== null,
  });
  const availableConnectors = mcpConnectorsData
    ? mcpConnectorsData.connectors
    : [];
  const mcpIconHref =
    externalMcpConnectorSlug === null
      ? undefined
      : findMcpConnectorIconHref({
          connectorSlug: externalMcpConnectorSlug,
          connectors: availableConnectors,
        });

  const approvalId = isApprovalRequested ? getApprovalId(part) : null;
  const shouldAutoApprove =
    !isBlocked &&
    hasAutomaticApproval({
      alwaysApprovedTools,
      canAlwaysAllow,
      conversationApprovedTools,
      isDocxEditBatch,
      isPublicOfficialApproval,
      name,
    });
  const automaticResponse =
    approvalId === null
      ? null
      : {
          key: `${approvalId}:${isBlocked ? "deny" : "approve"}`,
          respond: () => {
            setResponded(true);
            if (isBlocked) {
              onDeny(approvalId);
            } else if (shouldAutoApprove) {
              onApprove(approvalId, name);
            }
          },
          shouldRespond: isBlocked || shouldAutoApprove,
        };
  const beginManualResponse = (id: string): boolean => {
    if (submittedApprovalIdRef.current === id) {
      return false;
    }

    submittedApprovalIdRef.current = id;
    setResponded(true);
    return true;
  };

  const handleOpenReviewPanel = getDocxReviewPanelHandler({
    isDocxEditBatch,
    part,
  });

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- conditional role/handlers are paired below; the linter can't see they're always set together
    <div
      className={cn(
        "my-1 rounded-lg border text-sm",
        isApprovalRequested && !isProcessing
          ? "border-border bg-muted/30"
          : "bg-muted/40 border-transparent",
        handleOpenReviewPanel &&
          "hover:bg-muted/50 cursor-pointer transition-colors",
      )}
      onClick={handleOpenReviewPanel ?? undefined}
      onKeyDown={
        handleOpenReviewPanel
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleOpenReviewPanel();
              }
            }
          : undefined
      }
      role={handleOpenReviewPanel ? "button" : undefined}
      tabIndex={handleOpenReviewPanel ? 0 : undefined}
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
          <LoaderIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 animate-spin" />
        )}
        {isApproved && (
          <CheckIcon className="text-success ms-auto size-3.5 shrink-0" />
        )}
        {isDenied && (
          <XIcon className="text-destructive ms-auto size-3.5 shrink-0" />
        )}
      </div>

      <ToolApprovalSummary
        activeFileName={activeFileName}
        externalInput={showsExternalInput ? externalInput : undefined}
        isAwaitingExternalDecision={
          isApprovalRequested &&
          !isProcessing &&
          !isBlocked &&
          !isPublicOfficialApproval
        }
        part={part}
        providerName={externalMcpProviderName ?? label}
      />

      {/* Actions — hidden for DOCX edit batches (reviewed in the side panel). */}
      {approvalId &&
        !isProcessing &&
        !isBlocked &&
        !isDocxEditBatch &&
        !isPublicOfficialApproval && (
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
  externalInput,
  isAwaitingExternalDecision,
  part,
  providerName,
}: {
  activeFileName: string | undefined;
  externalInput: unknown;
  isAwaitingExternalDecision: boolean;
  part: ApprovalToolPart;
  providerName: string;
}) => {
  if (part.state === "input-streaming") {
    return null;
  }

  const name = getApprovalToolName(part);
  const input = getApprovalPartInput(part);
  return (
    <>
      {part.name === "update-entity-fields" && part.input !== undefined && (
        <UpdateSummary input={part.input} />
      )}
      {part.name === "apply-active-docx-edits" && part.input !== undefined && (
        <ActiveDocxEditSummary input={part.input} />
      )}
      {part.name === "create_workspace_document" &&
        part.input !== undefined && (
          <CreateWorkspaceDocumentSummary input={part.input} />
        )}
      {part.name === "edit_workspace_document" && part.input !== undefined && (
        <EditWorkspaceDocumentSummary
          activeFileName={activeFileName}
          input={part.input}
        />
      )}
      {part.name === "edit_workspace_document" &&
        part.state === "complete" &&
        part.output !== undefined && (
          <EditWorkspaceDocumentResult output={part.output} />
        )}
      {part.name === "spawn_subagents" && part.input !== undefined && (
        <SpawnSubagentsSubtaskList
          isAwaitingApproval={part.state === "approval-requested"}
          subagents={part.input.subagents}
        />
      )}
      {externalInput !== undefined && (
        <ExternalMcpInputSummary
          input={externalInput}
          isAwaitingDecision={isAwaitingExternalDecision}
          providerName={providerName}
        />
      )}
      {isRegistryWriteSummaryToolName(name) && input !== undefined && (
        <RegistryWriteSummary input={input} toolName={name} />
      )}
    </>
  );
};

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
  const { data } = useQuery(workspacesNavigationOptions(activeOrganizationId));
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
 * One approval-summary row. A value that is a matter id renders as the matter:
 * its name beside the layers glyph in the matter's own colour, the same way it
 * reads everywhere else in the app. The id itself is what the user least needs
 * to see when deciding whether to allow a write.
 */
const getDocxReviewPanelHandler = ({
  isDocxEditBatch,
  part,
}: {
  isDocxEditBatch: boolean;
  part: ApprovalToolPart;
}) => {
  const output =
    isDocxEditBatch &&
    part.name === "apply-active-docx-edits" &&
    part.state === "complete"
      ? part.output
      : undefined;
  const queued = output?.queued;
  if (queued === undefined || queued.length === 0) {
    return null;
  }
  const queuedIds = queued.map((item) => item.id);
  return () => {
    const opIds = new Set(queuedIds);
    const sessions = useReviewStore.getState().sessions;
    const entityIdMatch = Object.entries(sessions).find(([, items]) =>
      items.some((item) => opIds.has(item.id)),
    )?.[0];
    if (!entityIdMatch) {
      return;
    }
    const inspector = useInspectorTabsStore.getState();
    const tab = inspector.tabs.find(
      (candidate) =>
        candidate.type === "pdf" && candidate.entityId === entityIdMatch,
    );
    if (!tab) {
      return;
    }
    inspector.setActive(tab.id);
    inspector.setFileFacet(tab.id, "suggestions", { pulse: true });
  };
};

const getToolApprovalState = ({
  blockedApprovalTools,
  defaultLabel,
  name,
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
}) => {
  const isApprovalRequested = part.state === "approval-requested";
  const isApprovalResponded = part.state === "approval-responded";
  const isStructuredEditFailure =
    part.name === "edit_workspace_document" &&
    part.state === "complete" &&
    part.output !== undefined &&
    !part.output.success;
  const isApproved =
    part.state === "complete" &&
    part.output !== undefined &&
    !isStructuredEditFailure;
  const isDenied =
    isStructuredEditFailure ||
    (part.state === "approval-responded" && part.approval.approved === false);
  const isBlocked = blockedApprovalTools?.has(name) ?? false;
  const isExternalMcpApproval = isExternalMcpToolName(name);
  const showsExternalInput =
    isExternalMcpApproval || isExternalInputChatToolName(name);
  const isApprovalOnce = isApprovalOnceChatToolName(name);
  const canAllowInConversation =
    name !== "apply-active-docx-edits" &&
    !isApprovalOnce &&
    !isNonPersistentGrantChatToolName(name);
  const isDocxEditBatch = name === "apply-active-docx-edits";
  const externalMcpProviderName = getExternalMcpProviderName(name);

  return {
    canAllowInConversation,
    canAlwaysAllow: canAllowInConversation,
    externalInput:
      showsExternalInput && part.state !== "input-streaming"
        ? getApprovalPartInput(part)
        : undefined,
    externalMcpConnectorSlug: getExternalMcpConnectorSlug(name),
    externalMcpProviderName,
    isApprovalRequested,
    isApprovalResponded,
    isApproved,
    isBlocked,
    isDenied,
    isDocxEditBatch,
    isExternalMcpApproval,
    isProcessing: isApprovalResponded || (responded && isApprovalRequested),
    isPublicOfficialApproval: isPublicOfficialChatToolName(name),
    isStructuredEditFailure,
    label: externalMcpProviderName ?? defaultLabel,
    showsExternalInput,
  };
};

const RegistryWriteSummaryRow = ({
  label,
  matter,
  value,
}: {
  label: string;
  matter: SummaryMatter | undefined;
  value: string;
}) => (
  <div className="grid gap-1 sm:grid-cols-[9rem_1fr]">
    <dt className="text-muted-foreground text-xs">
      {matter ? stripIdSuffix(label) : label}
    </dt>
    <dd className="text-xs break-words">
      {matter ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <MatterIcon
            className="size-3.5 shrink-0"
            matter={{ color: matter.color, id: matter.id }}
          />
          <span className="truncate">{matter.name}</span>
        </span>
      ) : (
        value
      )}
    </dd>
  </div>
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
  const rows = buildRegistryWriteSummaryRows({
    documentLabel: t("common.document"),
    emptyLabel: t("common.empty"),
    input,
    toolName,
    uploadPlaceholder: t("chat.approval.uploadedDocumentPlaceholder"),
  });

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="border-border/50 border-t px-3 py-2">
      <dl className="space-y-1.5">
        {rows.map((row) => (
          <RegistryWriteSummaryRow
            key={row.key}
            label={row.label}
            matter={mattersById.get(row.value)}
            value={row.value}
          />
        ))}
      </dl>
    </div>
  );
};

const ExternalMcpInputSummary = ({
  input,
  isAwaitingDecision,
  providerName,
}: {
  input: unknown;
  isAwaitingDecision: boolean;
  providerName: string;
}) => {
  const t = useTranslations();
  const rows = getReadableInputRows({
    emptyLabel: t("common.empty"),
    input,
    requestLabel: t("chat.toolCall.input"),
  });

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
      <details className="group">
        <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
          {t("common.showDetails")}
        </summary>
        <div className="bg-background/60 mt-2 rounded-md border p-2">
          <dl className="space-y-1.5">
            {rows.map((row) => (
              <div className="grid gap-1 sm:grid-cols-[9rem_1fr]" key={row.key}>
                <dt className="text-muted-foreground text-xs">{row.label}</dt>
                <dd className="text-xs break-words">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
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
  if (iconHref) {
    return (
      <span className="bg-background flex size-4 shrink-0 items-center justify-center rounded-sm border">
        <img
          alt=""
          className="size-3 rounded-[2px] object-contain"
          height={12}
          src={iconHref}
          width={12}
        />
      </span>
    );
  }

  if (toolName === "web_search" || toolName === "fetch_url") {
    return <GlobeIcon className="text-muted-foreground size-4 shrink-0" />;
  }

  return <PencilIcon className="text-muted-foreground size-4 shrink-0" />;
};

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
  value.replace(/[^a-zA-Z0-9_-]/gu, "_");

const fallbackIconUrl = (rawUrl: string): string | undefined => {
  try {
    return new URL("/favicon.ico", rawUrl).toString();
  } catch {
    return undefined;
  }
};
