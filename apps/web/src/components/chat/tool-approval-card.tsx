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
  isSuggestChangesApplyOutput,
} from "@/components/chat/chat-ui-tools";
import type {
  ApprovalToolName,
  ApprovalToolPart,
  ChatUITools,
  SuggestChangesApplyOutput,
} from "@/components/chat/chat-ui-tools";
import { SpawnSubagentsSubtaskList } from "@/components/chat/spawn-subagents-card";
import {
  describeSuggestChangesApplyOutcome,
  hasAutomaticApproval,
} from "@/components/chat/tool-approval-card.logic";
import {
  buildRegistryWriteSummaryRows,
  formatReadableInputValue,
  getReadableInputRows,
  humanizeIdentifier,
} from "@/components/chat/tool-approval-summary";
import { MatterIcon } from "@/components/matter-icon";
import { useMountEffect } from "@/hooks/use-effect";
import type { DocxEditRepresentation } from "@/lib/chat-edit-mode";
import { DOCX_EDIT_REPRESENTATION } from "@/lib/chat-edit-mode";
import { detached } from "@/lib/detached";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { sanitizeHref } from "@/lib/sanitize-href";
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

/**
 * The fields the card shows for one proposed operation. The model-facing
 * `suggest_changes` input is loosely typed (folio's parser owns the
 * contract), so the card narrows each operation locally and skips anything
 * it cannot describe.
 */
type SummaryOperation = {
  type: string;
  blockId: string;
  find?: string;
  replace?: string;
};

const readOptionalString = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Range ops carry their anchor on the `find_text` handle; block ops carry it directly. */
const readSummaryOperation = (operation: unknown): SummaryOperation | null => {
  if (!isPlainRecord(operation)) {
    return null;
  }
  const type = readOptionalString(operation, "type");
  const range = operation["range"];
  const blockId =
    readOptionalString(operation, "blockId") ??
    (isPlainRecord(range) ? readOptionalString(range, "blockId") : undefined);
  if (type === undefined || blockId === undefined) {
    return null;
  }
  const find = readOptionalString(operation, "find");
  const replace = readOptionalString(operation, "replace");
  return {
    type,
    blockId,
    ...(find !== undefined && { find }),
    ...(replace !== undefined && { replace }),
  };
};

const SuggestChangesSummary = ({
  activeFileName,
  operations,
}: SuggestChangesSummaryProps) => {
  const t = useTranslations("chat.tool");
  const summaries = operations.flatMap((operation) => {
    const summary = readSummaryOperation(operation);
    return summary === null ? [] : [summary];
  });
  const previewOperations = summaries.slice(0, 3);
  // Only describable operations can be "more"; the count line above still
  // reports every operation the model sent.
  const hiddenCount = summaries.length - previewOperations.length;

  const renderOperationSummary = (operation: SummaryOperation) => {
    const { blockId } = operation;
    switch (operation.type) {
      case "replaceInBlock":
        return operation.find !== undefined && operation.replace !== undefined
          ? t("docxReplaceSummary", {
              find: operation.find,
              replace: operation.replace,
            })
          : t("docxReplaceBlockSummary", { blockId });
      // Range-addressed ops reuse the block-level summaries: the range
      // handle anchors to one block, and the card only needs to say
      // which block is touched.
      case "replaceBlock":
      case "replaceRange":
        return t("docxReplaceBlockSummary", { blockId });
      case "commentOnBlock":
      case "commentOnRange":
        return t("docxCommentSummary", { blockId });
      case "insertAfterBlock":
        return t("docxInsertAfterSummary", { blockId });
      case "insertBeforeBlock":
        return t("docxInsertBeforeSummary", { blockId });
      case "deleteBlock":
        return t("docxDeleteSummary", { blockId });
      case "insertSignatureTable":
        return t("docxSignatureTableSummary", { blockId });
      case "insertTableRow":
        return t("docxInsertTableRowSummary", { blockId });
      case "deleteTableRow":
        return t("docxDeleteTableRowSummary", { blockId });
      case "insertTableColumn":
        return t("docxInsertTableColumnSummary", { blockId });
      case "deleteTableColumn":
        return t("docxDeleteTableColumnSummary", { blockId });
      case "mergeTableCells":
        return t("docxMergeTableCellsSummary", { blockId });
      case "splitTableCell":
        return t("docxSplitTableCellSummary", { blockId });
      default:
        // An operation kind this card has no line for yet (folio's parser
        // decides validity); the count above still includes it.
        return t("docxReplaceBlockSummary", { blockId });
    }
  };

  return (
    <div className="border-border/50 flex flex-col gap-1.5 border-t px-3 py-2 text-xs">
      {activeFileName && (
        <div className="text-foreground-strong-muted truncate font-medium">
          {activeFileName}
        </div>
      )}
      <div className="text-muted-foreground">
        {t("docxEditSummary", { count: operations.length })}
      </div>
      {previewOperations.map((operation, index) => (
        <div
          className="text-foreground-strong-muted truncate"
          // eslint-disable-next-line react/no-array-index-key -- previewOperations is a read-only summary of an immutable AI tool-call input; never edited/reordered by the user.
          key={`${operation.blockId}-${operation.type}-${index}`}
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
      <div className="text-foreground-strong-muted truncate font-medium">
        {fileName}
      </div>
      <div className="text-muted-foreground line-clamp-4 whitespace-pre-wrap">
        {markdownPreview}
      </div>
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
  /** Threaded through for the `suggest_changes` approval summary; see
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

  return (
    <div
      className={cn(
        "my-1 rounded-lg border text-sm",
        isApprovalRequested && !isProcessing
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

      {approvalId &&
        !isProcessing &&
        !isBlocked &&
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
  // The server-executed `suggest_changes` variant reports a missing author
  // name as a structured outcome rather than a thrown error; the card shows
  // it as a decline with an inline remedy.
  const isStructuredEditFailure =
    part.name === "suggest_changes" &&
    part.state === "complete" &&
    part.output !== undefined &&
    isSuggestChangesApplyOutput(part.output) &&
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
  // High-impact writes may only be approved once or denied: no persistent
  // grant can auto-approve a later call.
  const isApprovalOnce = isApprovalOnceChatToolName(name);
  const canAllowInConversation =
    !isApprovalOnce && !isNonPersistentGrantChatToolName(name);
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
    isExternalMcpApproval,
    isProcessing: isApprovalResponded || (responded && isApprovalRequested),
    isPublicOfficialApproval: isPublicOfficialChatToolName(name),
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
  <div className="grid gap-1 sm:grid-cols-[9rem_1fr]">
    <dt className="text-muted-foreground text-xs">
      {matter ? stripIdSuffix(label) : label}
    </dt>
    <dd className="text-xs wrap-break-word">
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
                <dd className="text-xs wrap-break-word">{row.value}</dd>
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
