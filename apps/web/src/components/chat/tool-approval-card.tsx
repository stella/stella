import { useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import {
  CheckIcon,
  GlobeIcon,
  LoaderIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
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
import { hasAutomaticApproval } from "@/components/chat/tool-approval-card.logic";
import {
  buildRegistryWriteSummaryRows,
  getReadableInputRows,
  humanizeIdentifier,
} from "@/components/chat/tool-approval-summary";
import { useMountEffect } from "@/hooks/use-effect";
import { sanitizeHref } from "@/lib/sanitize-href";
import type { WorkspaceProperty } from "@/lib/types";
import { mcpConnectorsOptions } from "@/routes/_protected.knowledge/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  emptyColor,
  resolveOptionColor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { propertiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

type UpdateEntityFieldsInput = ChatUITools["update-entity-fields"]["input"];
type ActiveDocxEditInput = ChatUITools["apply-active-docx-edits"]["input"];

const getApprovalId = (part: ApprovalToolPart): string | null => {
  switch (part.state) {
    case "awaiting-input":
    case "input-complete":
    case "input-streaming":
      return null;
    case "approval-requested":
    case "approval-responded":
      return part.approval.id;
    case "complete":
      return part.approval.id;
    default:
      return null;
  }
};

const getApprovalPartInput = (part: ApprovalToolPart): unknown => part.input;

// -- Select badge (colored chip matching table UX) --

type SelectBadgeProps = {
  value: string | null;
  property: WorkspaceProperty | undefined;
};

const SelectBadge = ({ value, property }: SelectBadgeProps) => {
  const t = useTranslations();
  let color = emptyColor;

  if (value && property?.content.type === "single-select") {
    const opt = property.content.options.find((o) => o.value === value);
    if (opt) {
      color = resolveOptionColor(opt.color);
    }
  }

  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-none font-medium"
      style={{
        backgroundColor: color.background,
        color: color.foreground,
      }}
    >
      {value ?? t("common.empty")}
    </span>
  );
};

// -- Update summary (rich rendering) --

type UpdateSummaryProps = {
  input: UpdateEntityFieldsInput;
  workspaceId?: string | undefined;
};

const UpdateSummary = ({ input, workspaceId }: UpdateSummaryProps) => {
  const t = useTranslations();
  const qc = useQueryClient();
  const newVal = input.value;

  // Look up the property from cache for colors.
  let property: WorkspaceProperty | undefined;
  if (workspaceId) {
    const cached = qc.getQueryData<WorkspaceProperty[]>(
      propertiesKeys.all(workspaceId),
    );
    if (cached !== undefined) {
      property = cached.find((p) => p.id === input.propertyId);
    }
  }
  const propName = property?.name ?? input.propertyId;

  const isSelect =
    property?.content.type === "single-select" ||
    property?.content.type === "multi-select";

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
        {input.entityId}
      </code>
      {/* Property change */}
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">{propName}:</span>
        {isSelect ? (
          <SelectBadge property={property} value={displayNew} />
        ) : (
          <span className="font-medium">{displayNew ?? t("common.empty")}</span>
        )}
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

// -- Main card --

type ToolApprovalCardProps = {
  part: ApprovalToolPart;
  workspaceId?: string | undefined;
};

const AutomaticApprovalResponse = ({ respond }: { respond: () => void }) => {
  useMountEffect(() => {
    respond();
  });

  return null;
};

export const ToolApprovalCard = ({
  part,
  workspaceId,
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

  const isApprovalRequested = part.state === "approval-requested";
  const isApprovalResponded = part.state === "approval-responded";
  const isApproved = part.state === "complete" && part.output !== undefined;
  const isDenied =
    part.state === "approval-responded" && part.approval.approved === false;
  const isProcessing =
    isApprovalResponded || (responded && isApprovalRequested);
  const isBlocked = blockedApprovalTools?.has(name) ?? false;
  const isExternalMcpApproval = isExternalMcpToolName(name);
  const showsExternalInput =
    isExternalMcpApproval || isExternalInputChatToolName(name);
  // High-impact writes may only be approved once or denied: no persistent
  // grant can auto-approve a later call.
  const isApprovalOnce = isApprovalOnceChatToolName(name);
  const canAllowInConversation =
    name !== "apply-active-docx-edits" &&
    !isApprovalOnce &&
    !isNonPersistentGrantChatToolName(name);
  const canAlwaysAllow = canAllowInConversation;
  const isPublicOfficialApproval = isPublicOfficialChatToolName(name);
  /**
   * DOCX edit batches always go to the side review panel — never
   * gated by a chat-level Allow/Deny. The card collapses to a
   * compact status and auto-approves once so the queueing
   * handler can register the suggestions.
   */
  const isDocxEditBatch = name === "apply-active-docx-edits";
  const externalMcpProviderName = getExternalMcpProviderName(name);
  const label = externalMcpProviderName ?? t(getChatToolTitleKey(name));
  const externalMcpConnectorSlug = getExternalMcpConnectorSlug(name);
  const externalInput =
    showsExternalInput && part.state !== "input-streaming"
      ? getApprovalPartInput(part)
      : undefined;
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

  // Clicking a DOCX-edit-batch card jumps the user to the review
  // facet for the entity those edits target. The output's `queued`
  // ids are the same client-side suggestion ids the review store
  // keys its session entries by, so we look up the entity by
  // matching any of them.
  const docxEditBatchOutput =
    isDocxEditBatch &&
    part.name === "apply-active-docx-edits" &&
    part.state === "complete"
      ? part.output
      : undefined;
  const queuedIds =
    docxEditBatchOutput?.queued !== undefined
      ? docxEditBatchOutput.queued.map((q) => q.id)
      : null;
  const handleOpenReviewPanel =
    queuedIds !== null && queuedIds.length > 0
      ? () => {
          const opIds = new Set(queuedIds);
          const sessions = useReviewStore.getState().sessions;
          const entityIdMatch = Object.entries(sessions).find(([, items]) =>
            items.some((item) => opIds.has(item.id)),
          )?.[0];
          if (!entityIdMatch) {
            return;
          }
          const inspector = useInspectorStore.getState();
          const tab = inspector.tabs.find(
            (candidate) =>
              candidate.type === "pdf" && candidate.entityId === entityIdMatch,
          );
          if (!tab) {
            return;
          }
          inspector.setActive(tab.id);
          inspector.setFileFacet(tab.id, "suggestions", { pulse: true });
        }
      : null;

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

      {/* Rich summary */}
      {part.name === "update-entity-fields" &&
        part.state !== "input-streaming" &&
        part.input !== undefined && (
          <UpdateSummary input={part.input} workspaceId={workspaceId} />
        )}
      {part.name === "apply-active-docx-edits" &&
        part.state !== "input-streaming" &&
        part.input !== undefined && (
          <ActiveDocxEditSummary input={part.input} />
        )}
      {part.name === "spawn_subagents" &&
        part.state !== "input-streaming" &&
        part.input !== undefined && (
          <SpawnSubagentsSubtaskList
            isAwaitingApproval={isApprovalRequested}
            subagents={part.input.subagents}
          />
        )}
      {showsExternalInput &&
        part.state !== "input-streaming" &&
        externalInput !== undefined && (
          <ExternalMcpInputSummary
            input={externalInput}
            isAwaitingDecision={
              isApprovalRequested &&
              !isProcessing &&
              !isBlocked &&
              !isPublicOfficialApproval
            }
            providerName={externalMcpProviderName ?? label}
          />
        )}
      {isRegistryWriteSummaryToolName(name) &&
        part.state !== "input-streaming" &&
        getApprovalPartInput(part) !== undefined && (
          <RegistryWriteSummary
            input={getApprovalPartInput(part)}
            toolName={name}
          />
        )}

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

const RegistryWriteSummary = ({
  input,
  toolName,
}: {
  input: unknown;
  toolName: string;
}) => {
  const t = useTranslations();
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
          <div className="grid gap-1 sm:grid-cols-[9rem_1fr]" key={row.key}>
            <dt className="text-muted-foreground text-xs">{row.label}</dt>
            <dd className="text-xs break-words">{row.value}</dd>
          </div>
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
          {t("folio.showDetails")}
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

function ToolApprovalLeadingIcon({
  iconHref,
  toolName,
}: {
  iconHref?: string | undefined;
  toolName?: ApprovalToolName | undefined;
}) {
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
  value.replace(/[^a-zA-Z0-9_-]/gu, "_");

const fallbackIconUrl = (rawUrl: string): string | undefined => {
  try {
    return new URL("/favicon.ico", rawUrl).toString();
  } catch {
    return undefined;
  }
};
