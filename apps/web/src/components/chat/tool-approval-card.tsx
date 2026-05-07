import { useEffect, useRef, useState } from "react";

import { cn } from "@stll/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  CheckIcon,
  LoaderIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
import {
  getChatToolTitleKey,
  isExternalMcpToolName,
} from "@/components/chat/chat-ui-tools";
import type {
  ApprovalToolName,
  ApprovalToolPart,
  ChatUITools,
} from "@/components/chat/chat-ui-tools";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import type { WorkspaceProperty } from "@/lib/types";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  emptyColor,
  resolveOptionColor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { propertiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument" +
  ".wordprocessingml.document";

type UpdateEntityFieldsInput = ChatUITools["update-entity-fields"]["input"];
type CreateDocumentInput = ChatUITools["create-document"]["input"];
type CreateDocumentOutput = ChatUITools["create-document"]["output"];
type ActiveDocxEditInput = ChatUITools["apply-active-docx-edits"]["input"];

/** Guess a mime type from a file name extension. */
const mimeFromName = (name: string): string => {
  const ext = name.split(".").pop()?.toLowerCase();

  if (!ext) {
    return "application/octet-stream";
  }

  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "doc":
      return "application/msword";
    case "docx":
      return DOCX_MIME;
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "csv":
      return "text/csv";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
};

const getApprovalId = (part: ApprovalToolPart): string | null => {
  switch (part.state) {
    case "input-available":
    case "input-streaming":
      return null;
    case "approval-requested":
    case "approval-responded":
    case "output-denied":
      return part.approval.id;
    case "output-available":
    case "output-error":
      return part.approval?.id ?? null;
    default:
      return null;
  }
};

const getApprovalToolName = (part: ApprovalToolPart): ApprovalToolName => {
  const toolName = part.type.slice("tool-".length);
  if (isExternalMcpToolName(toolName)) {
    return toolName;
  }

  switch (part.type) {
    case "tool-apply-active-docx-edits":
      return "apply-active-docx-edits";
    case "tool-create-document":
      return "create-document";
    case "tool-update-entity-fields":
      return "update-entity-fields";
    default:
      part satisfies never;
      throw new Error("Unsupported approval tool");
  }
};

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
  const propName = input.propertyName ?? t("chat.toolCall.field");
  const entityName = input.entityName;
  const newVal = input.value;
  const oldVal = input.oldValue;

  // Look up the property from cache for colors.
  let property: WorkspaceProperty | undefined;
  if (workspaceId) {
    const cached = qc.getQueryData<WorkspaceProperty[]>(
      propertiesKeys.all(workspaceId),
    );
    if (
      cached !== undefined &&
      input.propertyId !== undefined &&
      input.propertyId !== null
    ) {
      property = cached.find((p) => p.id === input.propertyId);
    }
  }

  const isSelect =
    property?.content.type === "single-select" ||
    property?.content.type === "multi-select";

  const displayNew =
    newVal === null
      ? null
      : Array.isArray(newVal)
        ? newVal.join(", ")
        : JSON.stringify(newVal);

  return (
    <div className="border-border/50 flex flex-col gap-1.5 border-t px-3 py-2">
      {/* Property change */}
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">{propName}:</span>
        {isSelect ? (
          <>
            {oldVal && (
              <>
                <SelectBadge property={property} value={oldVal} />
                <ArrowRightIcon className="text-muted-foreground size-3 shrink-0" />
              </>
            )}
            <SelectBadge property={property} value={displayNew} />
          </>
        ) : (
          <span className="font-medium">
            {oldVal && (
              <>
                <span className="text-muted-foreground line-through">
                  {oldVal}
                </span>
                {" → "}
              </>
            )}
            {displayNew ?? t("common.empty")}
          </span>
        )}
      </div>

      {/* Entity name with icon */}
      {entityName && (
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <DocumentIcon
            className="size-3.5 shrink-0"
            mimeType={
              entityName.includes(".")
                ? mimeFromName(entityName)
                : "application/octet-stream"
            }
          />
          <span className="truncate">{entityName}</span>
        </div>
      )}
    </div>
  );
};

// -- Create document summary --

type CreateSummaryProps = {
  input: CreateDocumentInput;
  output?: CreateDocumentOutput | undefined;
};

const CreateSummary = ({ input, output }: CreateSummaryProps) => {
  const name = `${input.name}.docx`;

  if (output && output.success) {
    return (
      <div className="border-border/50 text-muted-foreground flex items-center gap-1.5 border-t px-3 py-2 text-xs">
        <StreamdownMentionLink href={output.href} interactive>
          {output.fileName}
        </StreamdownMentionLink>
      </div>
    );
  }

  return (
    <div className="border-border/50 text-muted-foreground flex items-center gap-1.5 border-t px-3 py-2 text-xs">
      <DocumentIcon className="size-3.5 shrink-0" mimeType={DOCX_MIME} />
      <span className="truncate">{name}</span>
    </div>
  );
};

// -- Active DOCX edit summary --

type ActiveDocxEditSummaryProps = {
  input: ActiveDocxEditInput;
};

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
      default:
        operation satisfies never;
        throw new Error("Unsupported DOCX edit operation");
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

// -- Main card --

type ToolApprovalCardProps = {
  part: ApprovalToolPart;
  onApprove: (
    id: string,
    toolName: ApprovalToolName,
  ) => void | PromiseLike<void>;
  onDeny: (id: string) => void | PromiseLike<void>;
  onAlwaysAllow: (toolName: ApprovalToolName) => void;
  autoApprovedTools: ReadonlySet<ApprovalToolName>;
  blockedApprovalTools?: ReadonlySet<ApprovalToolName> | undefined;
  workspaceId?: string | undefined;
};

export const ToolApprovalCard = ({
  part,
  onApprove,
  onDeny,
  onAlwaysAllow,
  autoApprovedTools,
  blockedApprovalTools,
  workspaceId,
}: ToolApprovalCardProps) => {
  const t = useTranslations();
  const name = getApprovalToolName(part);
  const autoApproveRef = useRef(false);
  const autoDenyRef = useRef(false);
  const [responded, setResponded] = useState(false);

  const isApprovalRequested = part.state === "approval-requested";
  const isApprovalResponded = part.state === "approval-responded";
  const isApproved = part.state === "output-available";
  const isDenied = part.state === "output-denied";
  const isProcessing =
    isApprovalResponded || (responded && isApprovalRequested);
  const isBlocked = blockedApprovalTools?.has(name) ?? false;
  const isExternalMcpApproval = isExternalMcpToolName(name);
  const canAlwaysAllow =
    name !== "apply-active-docx-edits" && !isExternalMcpApproval;
  /**
   * DOCX edit batches always go to the side review panel — never
   * gated by a chat-level Allow/Deny. The card collapses to a
   * compact status and auto-approves once so the queueing
   * handler can register the suggestions.
   */
  const isDocxEditBatch = name === "apply-active-docx-edits";

  useEffect(() => {
    if (!isApprovalRequested || !isBlocked || autoDenyRef.current) {
      return;
    }
    const id = getApprovalId(part);
    if (!id) {
      return;
    }
    autoDenyRef.current = true;
    setResponded(true);
    onDeny(id);
  }, [isApprovalRequested, isBlocked, part, onDeny]);

  // Auto-approve if the tool is in the always-allow set, OR if
  // this is a DOCX edit batch (review happens per item in the side
  // panel; the chat-level gate would just be friction).
  useEffect(() => {
    if (
      !isApprovalRequested ||
      isBlocked ||
      autoApproveRef.current ||
      (!isDocxEditBatch && !canAlwaysAllow) ||
      (!isDocxEditBatch && !autoApprovedTools.has(name))
    ) {
      return;
    }
    const id = getApprovalId(part);
    if (!id) {
      return;
    }
    autoApproveRef.current = true;
    setResponded(true);
    onApprove(id, name);
  }, [
    isApprovalRequested,
    isBlocked,
    canAlwaysAllow,
    autoApprovedTools,
    isDocxEditBatch,
    name,
    part,
    onApprove,
  ]);

  const label = t(getChatToolTitleKey(name));

  const approvalId = isApprovalRequested ? getApprovalId(part) : null;

  // Clicking a DOCX-edit-batch card jumps the user to the review
  // facet for the entity those edits target. The output's `queued`
  // ids are the same client-side suggestion ids the review store
  // keys its session entries by, so we look up the entity by
  // matching any of them.
  const queuedIds: string[] | null =
    isDocxEditBatch &&
    part.type === "tool-apply-active-docx-edits" &&
    part.state === "output-available" &&
    part.output.queued !== undefined
      ? part.output.queued.map((q) => q.id)
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
          inspector.setPdfFacet(tab.id, "suggestions", { pulse: true });
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
      {/* Header: icon + label + status */}
      <div className="flex items-center gap-2 px-3 py-2">
        <PencilIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="font-medium">{label}</span>
        {isProcessing && (
          <LoaderIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 animate-spin" />
        )}
        {isApproved && (
          <CheckIcon className="ms-auto size-3.5 shrink-0 text-green-600 dark:text-green-400" />
        )}
        {isDenied && (
          <XIcon className="text-destructive ms-auto size-3.5 shrink-0" />
        )}
      </div>

      {/* Rich summary */}
      {part.type === "tool-update-entity-fields" &&
        part.state !== "input-streaming" &&
        part.input !== undefined && (
          <UpdateSummary input={part.input} workspaceId={workspaceId} />
        )}
      {part.type === "tool-create-document" &&
        part.state !== "input-streaming" &&
        part.input !== undefined && (
          <CreateSummary
            input={part.input}
            output={part.state === "output-available" ? part.output : undefined}
          />
        )}
      {part.type === "tool-apply-active-docx-edits" &&
        part.state !== "input-streaming" &&
        part.input !== undefined && (
          <ActiveDocxEditSummary input={part.input} />
        )}
      {isExternalMcpApproval &&
        part.state !== "input-streaming" &&
        "input" in part &&
        part.input !== undefined && (
          <ExternalMcpInputSummary input={part.input} />
        )}

      {/* Actions — hidden for DOCX edit batches (reviewed in the side panel). */}
      {approvalId && !isProcessing && !isBlocked && !isDocxEditBatch && (
        <div className="border-border/50 flex items-center gap-2 border-t px-3 py-2 text-xs">
          <button
            autoFocus
            className="bg-foreground text-background focus-visible:ring-ring rounded-md px-2.5 py-1 font-medium transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-offset-1"
            onClick={() => {
              setResponded(true);
              onApprove(approvalId, name);
            }}
            type="button"
          >
            {t("chat.approval.allow")}
          </button>
          <button
            className="text-muted-foreground hover:text-foreground rounded-md border px-2.5 py-1 transition-colors"
            onClick={() => {
              setResponded(true);
              onDeny(approvalId);
            }}
            type="button"
          >
            {t("chat.approval.deny")}
          </button>
          {canAlwaysAllow && (
            <button
              className="text-muted-foreground ms-auto underline-offset-2 hover:underline"
              onClick={() => {
                setResponded(true);
                onAlwaysAllow(name);
                onApprove(approvalId, name);
              }}
              type="button"
            >
              {t("chat.approval.alwaysAllow")}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const ExternalMcpInputSummary = ({ input }: { input: unknown }) => (
  <div className="border-border/50 border-t px-3 py-2">
    <pre className="bg-background/70 max-h-48 overflow-auto rounded-md border px-2 py-1.5 text-[11px] leading-4 whitespace-pre-wrap">
      {JSON.stringify(input, null, 2)}
    </pre>
  </div>
);
