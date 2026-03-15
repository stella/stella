import { useEffect, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { getToolName } from "ai";
import {
  ArrowRightIcon,
  CheckIcon,
  LoaderIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import type { WorkspaceProperty } from "@/lib/types";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import {
  emptyColor,
  optionColorsMap,
} from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { propertiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument" +
  ".wordprocessingml.document";

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

const getApprovalId = (part: ToolPart): string | null => {
  if (
    "approval" in part &&
    typeof part.approval === "object" &&
    part.approval !== null &&
    "id" in part.approval
  ) {
    return part.approval.id;
  }
  return null;
};

type ToolPart = Parameters<typeof getToolName>[0];

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
      color = optionColorsMap[opt.color] ?? emptyColor;
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
  input: Record<string, unknown>;
  workspaceId?: string | undefined;
};

const UpdateSummary = ({ input, workspaceId }: UpdateSummaryProps) => {
  const qc = useQueryClient();
  // SAFETY: from validated update-entity-fields tool input
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const propName = (input.propertyName as string | undefined) ?? "field";
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: from validated tool input
  const entityName = input.entityName as string | undefined;
  const newVal = input.value;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: from validated tool input
  const oldVal = input.oldValue as string | undefined;

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
            {displayNew ?? "(empty)"}
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
  input: Record<string, unknown>;
};

const CreateSummary = ({ input }: CreateSummaryProps) => {
  const rawName = input.name;
  const name =
    typeof rawName === "string" ? `${rawName}.docx` : "document.docx";
  return (
    <div className="border-border/50 text-muted-foreground flex items-center gap-1.5 border-t px-3 py-2 text-xs">
      <DocumentIcon className="size-3.5 shrink-0" mimeType={DOCX_MIME} />
      <span className="truncate">{name}</span>
    </div>
  );
};

// -- Main card --

type ToolApprovalCardProps = {
  part: ToolPart;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onAlwaysAllow: (toolName: string) => void;
  autoApprovedTools: ReadonlySet<string>;
  workspaceId?: string | undefined;
};

export const ToolApprovalCard = ({
  part,
  onApprove,
  onDeny,
  onAlwaysAllow,
  autoApprovedTools,
  workspaceId,
}: ToolApprovalCardProps) => {
  const t = useTranslations();
  const name = getToolName(part);
  const autoApproveRef = useRef(false);
  const [responded, setResponded] = useState(false);

  const isApprovalRequested = part.state === "approval-requested";
  const isApprovalResponded = part.state === "approval-responded";
  const isApproved = part.state === "output-available";
  const isDenied =
    part.state === "output-error" &&
    "errorText" in part &&
    part.errorText === "denied";
  const isProcessing =
    isApprovalResponded || (responded && isApprovalRequested);

  // Auto-approve if the tool is in the always-allow set
  useEffect(() => {
    if (
      !isApprovalRequested ||
      !autoApprovedTools.has(name) ||
      autoApproveRef.current
    ) {
      return;
    }
    const id = getApprovalId(part);
    if (!id) {
      return;
    }
    autoApproveRef.current = true;
    setResponded(true);
    onApprove(id);
  }, [isApprovalRequested, autoApprovedTools, name, part, onApprove]);

  // SAFETY: input from validated tool part
  const input =
    "input" in part
      ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        (part.input as Record<string, unknown>)
      : null;

  const toolLabels: Record<string, string> = {
    updateEntityFields: t("chat.tool.updateEntityFields"),
    createDocument: t("chat.tool.createDocument"),
  };
  const label = toolLabels[name] ?? name;

  const approvalId = isApprovalRequested ? getApprovalId(part) : null;

  return (
    <div
      className={cn(
        "my-1 rounded-lg border text-sm",
        isApprovalRequested && !isProcessing
          ? "border-border bg-muted/30"
          : "bg-muted/40 border-transparent",
      )}
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
      {input && name === "updateEntityFields" && (
        <UpdateSummary input={input} workspaceId={workspaceId} />
      )}
      {input && name === "createDocument" && <CreateSummary input={input} />}

      {/* Actions */}
      {approvalId && !isProcessing && (
        <div className="border-border/50 flex items-center gap-2 border-t px-3 py-2 text-xs">
          <button
            autoFocus
            className="bg-foreground text-background focus-visible:ring-ring rounded-md px-2.5 py-1 font-medium transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-offset-1"
            onClick={() => {
              setResponded(true);
              onApprove(approvalId);
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
          <button
            className="text-muted-foreground ms-auto underline-offset-2 hover:underline"
            onClick={() => {
              setResponded(true);
              onAlwaysAllow(name);
              onApprove(approvalId);
            }}
            type="button"
          >
            {t("chat.approval.alwaysAllow")}
          </button>
        </div>
      )}
    </div>
  );
};
