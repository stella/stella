import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { openFilePicker } from "@stll/ui/file-picker";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  UploadIcon,
  AiActionIcon,
  XIcon,
} from "@stll/ui/icons";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { MatterDocumentPicker } from "@/components/workspaces/matter-document-picker";
import { resolveAppTimeZone } from "@/i18n/time-zone";
import { api } from "@/lib/api";
import { DOCX_MIME, PDF_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";

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

const ACCEPTED_MIME_TYPES: readonly string[] = Object.freeze([
  DOCX_MIME,
  PDF_MIME,
]);

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

  const acceptFile = (candidate: File | undefined) => {
    if (!candidate) {
      return;
    }
    if (!ACCEPTED_MIME_TYPES.includes(candidate.type)) {
      notifyUserError(undefined, t("templates.invalidFileType"));
      return;
    }
    setFile(candidate);
  };

  const hasSource =
    file !== null || pastedText.trim() !== "" || pickedEntityIds.length > 0;

  const runPrefill = async () => {
    setLoading(true);
    const body: {
      file?: File;
      text?: string;
      entityIds?: string;
      timezone: string;
    } = { timezone: resolveAppTimeZone() };
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
      notifyUserError(
        response.error ? toAPIError(response.error) : undefined,
        t("templates.prefillFailed"),
      );
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
          <DirectionalIcon
            className="text-muted-foreground size-4 shrink-0"
            icon={ChevronRightIcon}
          />
        )}
        <AiActionIcon className="text-muted-foreground size-4 shrink-0" />
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
                "text-muted-foreground hover:text-foreground hover:border-ring flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-4 text-sm",
                dragOver && "border-ring text-foreground",
              )}
              onClick={() => {
                openFilePicker({
                  accept: ".docx,.pdf",
                  onPick: ([candidate]) => acceptFile(candidate),
                });
              }}
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
            onClick={() =>
              detached(runPrefill(), "template-prefill-panel.run-prefill")
            }
            size="sm"
            type="button"
          >
            <AiActionIcon />
            {loading ? t("common.loading") : t("templates.prefillRun")}
          </Button>
        </div>
      )}
    </section>
  );
};
