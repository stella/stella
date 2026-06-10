import { useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  UploadIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { api } from "@/lib/api";
import { DOCX_MIME, PDF_MIME } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { workspaceFilesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

/**
 * "Prefill from documents" affordance on the template fill form: a drop
 * zone for one DOCX/PDF, a paste-text area, and (when the form is opened
 * from a matter) a bounded picker over that matter's stored documents.
 * The server extracts all text and proposes per-field values; the form
 * applies them as reviewable, freely editable suggestions. Nothing is
 * submitted automatically.
 */

type PrefillResponse = Awaited<
  ReturnType<ReturnType<typeof api.templates>["prefill"]["post"]>
>;

type PrefillData = Exclude<
  NonNullable<Extract<PrefillResponse, { data: unknown }>["data"]>,
  Response
>;

export type PrefillSuggestionDto = PrefillData["fields"][number];

const ACCEPTED_MIME_TYPES = new Set<string>([DOCX_MIME, PDF_MIME]);
const MAX_MATTER_DOCUMENTS = 30;
const MAX_PICKED_DOCUMENTS = 5;

type TemplatePrefillPanelProps = {
  templateId: string;
  /** Matter whose stored documents are offered as sources. */
  matterWorkspaceId?: string | undefined;
  /** Apply the proposals to the form; returns how many were applied. */
  onApply: (suggestions: PrefillSuggestionDto[]) => number;
};

export const TemplatePrefillPanel = ({
  templateId,
  matterWorkspaceId,
  onApply,
}: TemplatePrefillPanelProps) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [pickedEntityIds, setPickedEntityIds] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const acceptFile = (candidate: File | undefined) => {
    if (!candidate) {
      return;
    }
    if (!ACCEPTED_MIME_TYPES.has(candidate.type)) {
      stellaToast.add({
        type: "error",
        title: t("templates.invalidFileType"),
      });
      return;
    }
    setFile(candidate);
  };

  const hasSource =
    file !== null || pastedText.trim() !== "" || pickedEntityIds.length > 0;

  const runPrefill = async () => {
    setLoading(true);
    const body: { file?: File; text?: string; entityIds?: string } = {};
    if (file) {
      body.file = file;
    }
    if (pastedText.trim() !== "") {
      body.text = pastedText;
    }
    if (pickedEntityIds.length > 0) {
      body.entityIds = JSON.stringify(pickedEntityIds);
    }

    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .prefill.post(body);
    setLoading(false);

    if (response.error || response.data instanceof Response) {
      stellaToast.add({
        type: "error",
        title: t("templates.prefillFailed"),
        description: response.error
          ? userErrorMessage(response.error, t("common.unexpectedError"))
          : undefined,
      });
      return;
    }

    const applied = onApply(response.data.fields);
    if (applied === 0) {
      stellaToast.add({
        type: "info",
        title: t("templates.prefillNoValues"),
      });
      return;
    }
    stellaToast.add({
      type: "success",
      title: t("templates.prefillApplied", { count: applied }),
    });
  };

  return (
    <section className="rounded-lg border">
      <button
        aria-expanded={expanded}
        className="hover:bg-muted/50 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-start"
        onClick={() => setExpanded((prev) => !prev)}
        type="button"
      >
        {expanded ? (
          <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
        ) : (
          <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
        )}
        <WandSparklesIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="text-sm font-medium">
          {t("templates.prefillTitle")}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 border-t p-3">
          <p className="text-muted-foreground text-xs">
            {t("templates.prefillDescription")}
          </p>

          {/* Drop zone / picked file */}
          {file === null ? (
            <button
              className={cn(
                "text-muted-foreground hover:text-foreground hover:border-ring flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-4 text-sm transition-colors",
                dragOver && "border-ring text-foreground",
              )}
              onClick={() => fileInputRef.current?.click()}
              onDragLeave={() => setDragOver(false)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                acceptFile(e.dataTransfer.files[0]);
              }}
              type="button"
            >
              <UploadIcon className="size-4 shrink-0" />
              {t("templates.prefillDropHint")}
            </button>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
              <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <Button
                aria-label={t("common.remove")}
                onClick={() => setFile(null)}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </div>
          )}
          <input
            accept=".docx,.pdf"
            className="hidden"
            onChange={(e) => {
              acceptFile(e.target.files?.item(0) ?? undefined);
              e.target.value = "";
            }}
            ref={fileInputRef}
            type="file"
          />

          {/* Paste text */}
          {pasteOpen ? (
            <Textarea
              className="min-h-24"
              onChange={(e) => setPastedText(e.target.value)}
              placeholder={t("templates.prefillPasteTextPlaceholder")}
              value={pastedText}
            />
          ) : (
            <Button
              className="self-start"
              onClick={() => setPasteOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("templates.prefillPasteText")}
            </Button>
          )}

          {matterWorkspaceId !== undefined && (
            <MatterDocumentPicker
              pickedEntityIds={pickedEntityIds}
              onChange={setPickedEntityIds}
              workspaceId={matterWorkspaceId}
            />
          )}

          <Button
            className="self-end"
            disabled={!hasSource || loading}
            onClick={() => void runPrefill()}
            size="sm"
            type="button"
          >
            <WandSparklesIcon />
            {loading ? t("common.loading") : t("templates.prefillRun")}
          </Button>
        </div>
      )}
    </section>
  );
};

type MatterDocumentPickerProps = {
  workspaceId: string;
  pickedEntityIds: string[];
  onChange: (entityIds: string[]) => void;
};

/** Bounded checkbox list over the matter's stored DOCX/PDF documents. */
const MatterDocumentPicker = ({
  workspaceId,
  pickedEntityIds,
  onChange,
}: MatterDocumentPickerProps) => {
  const t = useTranslations();
  const { data: files } = useQuery(workspaceFilesOptions(workspaceId));

  const documents = (files ?? [])
    .filter((f) => f.mimeType === DOCX_MIME || f.mimeType === PDF_MIME)
    .slice(0, MAX_MATTER_DOCUMENTS);

  if (documents.length === 0) {
    return null;
  }

  const toggle = (entityId: string) => {
    if (pickedEntityIds.includes(entityId)) {
      onChange(pickedEntityIds.filter((id) => id !== entityId));
      return;
    }
    if (pickedEntityIds.length >= MAX_PICKED_DOCUMENTS) {
      return;
    }
    onChange([...pickedEntityIds, entityId]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">
        {t("templates.prefillMatterDocuments")}
      </span>
      <div className="flex max-h-36 flex-col gap-1 overflow-y-auto rounded-lg border p-2">
        {documents.map((doc) => {
          const checked = pickedEntityIds.includes(doc.entityId);
          return (
            <label
              className="flex cursor-pointer items-center gap-2 text-sm"
              key={doc.entityId}
            >
              <Checkbox
                checked={checked}
                disabled={
                  !checked && pickedEntityIds.length >= MAX_PICKED_DOCUMENTS
                }
                onCheckedChange={() => toggle(doc.entityId)}
              />
              <span className="min-w-0 truncate">
                {doc.name ?? doc.fileName}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
};
