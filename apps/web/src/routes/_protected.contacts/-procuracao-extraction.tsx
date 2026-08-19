import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { AlertTriangleIcon, FileTextIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { useExternalFileDrop } from "@/hooks/use-external-file-drop";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { isDocxFile } from "@/lib/consts";
import { contactsKeys } from "@/lib/contacts/queries";
import { toAPIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { fetchWithTimeout } from "@/lib/fetch";
import { sha256Hex } from "@/lib/files/sha256";
import { customFieldId } from "@/routes/_protected.contacts/-import-candidate";
import type {
  ImportCandidate,
  ImportEditableField,
} from "@/routes/_protected.contacts/-import-candidate";
import {
  ImportCandidateCard,
  ImportResultsList,
  useImportReview,
} from "@/routes/_protected.contacts/-import-review";
import type { ImportReview } from "@/routes/_protected.contacts/-import-review";

const EXTRACTION_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
const EXTRACTION_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** A procuração states Brazilian tax ids, so the batch is checksum-checked. */
const PROCURACAO_TAX_ID_SCHEME = "br_cpf_cnpj" as const;

type ExtractResponse = Awaited<
  ReturnType<(typeof api.contacts)["extract-from-procuracao"]["post"]>
>;

type ExtractData = Exclude<
  NonNullable<Extract<ExtractResponse, { data: unknown }>["data"]>,
  Response
>;

type OutorganteCandidate = ExtractData["outorgantes"][number];

/**
 * The qualification a procuração states about a grantor has no first-class
 * contact field, so each label lands in `metadata.customFields` under its own
 * Brazilian-Portuguese name — the wording the source document itself uses.
 */
const PROCURACAO_CUSTOM_FIELDS = [
  { key: "rg", label: "RG" },
  { key: "nacionalidade", label: "Nacionalidade" },
  { key: "estadoCivil", label: "Estado civil" },
  { key: "profissao", label: "Profissão" },
  { key: "uniaoEstavel", label: "União estável" },
] as const satisfies readonly {
  key: keyof OutorganteCandidate;
  label: string;
}[];

/** What a reviewer may edit on an extracted grantor. */
const PROCURACAO_REVIEW_FIELDS = [
  "type",
  "display_name",
  "tax_id",
  "primary_email",
  "address_line_1",
] as const satisfies readonly ImportEditableField[];

const trimmedOrUndefined = (value: string | null): string | undefined =>
  value?.trim() || undefined;

const toImportCandidate = (
  outorgante: OutorganteCandidate,
): ImportCandidate => {
  const customFields = PROCURACAO_CUSTOM_FIELDS.flatMap(
    ({ key, label }, index) => {
      const value = trimmedOrUndefined(outorgante[key]);
      return value ? [{ id: customFieldId(label, index), label, value }] : [];
    },
  );
  const email = trimmedOrUndefined(outorgante.email);
  const address = trimmedOrUndefined(outorgante.endereco);

  return {
    type: outorgante.contactType ?? "person",
    displayName: outorgante.nome?.trim() ?? "",
    taxId: trimmedOrUndefined(outorgante.taxId),
    emails: email
      ? [{ type: "work", address: email, isPrimary: true }]
      : undefined,
    addresses: address
      ? [{ type: "office", line1: address, isPrimary: true }]
      : undefined,
    metadata: customFields.length > 0 ? { customFields } : undefined,
  };
};

/**
 * Where the procuração flow currently sits, as seen by the host dialog:
 * `idle` shows the drop zone (plus whatever else the host renders),
 * `review` shows editable outorgante rows, `done` shows the import receipt.
 */
export type ProcuracaoExtractionStage = "idle" | "review" | "done";

export type ProcuracaoExtractionState = {
  stage: ProcuracaoExtractionStage;
  isExtracting: boolean;
  isConfirming: boolean;
  canConfirm: boolean;
  sourceTruncated: boolean;
  review: ImportReview;
  extractFile: (file: File) => Promise<void>;
  confirm: () => Promise<void>;
  reset: () => void;
};

/**
 * Upload a procuração, extract outorgante candidates, let the user edit them,
 * and commit them through the reviewed contact import. Presentation lives in
 * `ProcuracaoDropZone` and `ProcuracaoReview`; the host dialog decides where
 * to place them.
 */
export const useProcuracaoExtraction = (): ProcuracaoExtractionState => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const review = useImportReview({
    onImported: async () => {
      await queryClient.invalidateQueries({ queryKey: contactsKeys.all });
    },
  });

  const [isExtracting, setIsExtracting] = useState(false);
  const [sourceTruncated, setSourceTruncated] = useState(false);

  const reset = () => {
    setIsExtracting(false);
    setSourceTruncated(false);
    review.reset();
  };

  const extractFile = async (file: File) => {
    if (!isDocxFile(file)) {
      stellaToast.add({
        title: t("contacts.extractProcuracao.invalidFileType"),
        type: "error",
      });
      return;
    }
    if (file.size > EXTRACTION_SOURCE_MAX_BYTES) {
      stellaToast.add({
        title: t("contacts.extractProcuracao.fileTooLarge"),
        type: "error",
      });
      return;
    }

    setIsExtracting(true);
    const extraction = await Result.tryPromise({
      try: async () => {
        const fileBuffer = await file.arrayBuffer();
        const presignResponse = await api.contacts["procuracao-upload"].post({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          sha256Hex: await sha256Hex(fileBuffer),
        });

        if (presignResponse.error) {
          throw toAPIError(presignResponse.error);
        }

        const putResponse = await fetchWithTimeout(presignResponse.data.url, {
          method: "PUT",
          headers: presignResponse.data.headers,
          body: file,
          timeoutMs: EXTRACTION_UPLOAD_TIMEOUT_MS,
        });
        if (!putResponse.ok) {
          throw new ClientOperationError({
            action: "upload-procuracao-source",
            message: `Upload failed with status ${putResponse.status}`,
          });
        }

        const response = await api.contacts["extract-from-procuracao"].post({
          uploadId: presignResponse.data.uploadId,
        });

        if (response.error) {
          throw toAPIError(response.error);
        }

        return response.data;
      },
      catch: (error) => error,
    });
    setIsExtracting(false);

    if (Result.isError(extraction)) {
      getAnalytics().captureError(extraction.error);
      stellaToast.add({
        title: userErrorFromThrown(
          extraction.error,
          t("contacts.extractProcuracao.parseErrorGeneric"),
        ),
        type: "error",
      });
      return;
    }

    const { outorgantes, truncated } = extraction.value;
    setSourceTruncated(truncated);
    if (outorgantes.length === 0) {
      stellaToast.add({
        title: t("contacts.extractProcuracao.noOutorganteFound"),
        type: "info",
      });
      return;
    }

    await review.seedValidated({
      candidates: outorgantes.map(toImportCandidate),
      taxIdScheme: PROCURACAO_TAX_ID_SCHEME,
    });
  };

  return {
    stage: resolveStage(review),
    isExtracting: isExtracting || review.isSeeding,
    isConfirming: review.isImporting,
    canConfirm: review.canImport,
    sourceTruncated,
    review,
    extractFile,
    confirm: review.commit,
    reset,
  };
};

const resolveStage = (review: ImportReview): ProcuracaoExtractionStage => {
  if (review.results) {
    return "done";
  }
  if (review.rows.length > 0) {
    return "review";
  }
  return "idle";
};

type ProcuracaoDropZoneProps = {
  isExtracting: boolean;
  onFile: (file: File) => void;
};

/**
 * Visible drop target for a procuração `.docx`: drag a file onto it, or click
 * (Enter/Space) to open the file picker. The host owns what happens with the
 * file; this only guards for a single file and hands it over.
 */
export const ProcuracaoDropZone = ({
  isExtracting,
  onFile,
}: ProcuracaoDropZoneProps) => {
  const t = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { ref, isDropTarget } = useExternalFileDrop({
    onDrop: (files) => {
      const file = files.at(0);
      if (file) {
        onFile(file);
      }
    },
    enabled: !isExtracting,
  });

  const openPicker = () => {
    if (!isExtracting) {
      fileInputRef.current?.click();
    }
  };

  return (
    <div ref={ref}>
      <button
        aria-busy={isExtracting}
        className={cn(
          "bg-muted/20 hover:bg-muted/40 focus-visible:ring-ring flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none",
          isDropTarget && "border-primary bg-primary/5",
          isExtracting && "cursor-progress",
        )}
        disabled={isExtracting}
        onClick={openPicker}
        type="button"
      >
        {isExtracting ? (
          <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
        ) : (
          <FileTextIcon className="text-muted-foreground size-5" />
        )}
        <span className="text-sm font-medium">
          {t(
            isExtracting
              ? "contacts.extractProcuracao.extracting"
              : "contacts.extractProcuracao.dropZone",
          )}
        </span>
        <span className="text-muted-foreground text-xs">
          {t("contacts.extractProcuracao.fileHint")}
        </span>
      </button>
      <input
        accept=".docx"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            onFile(file);
          }
          event.target.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />
    </div>
  );
};

type ProcuracaoReviewProps = {
  extraction: Pick<ProcuracaoExtractionState, "review" | "sourceTruncated">;
};

/** Editable outorgante rows before confirmation, or the receipt after it. */
export const ProcuracaoReview = ({ extraction }: ProcuracaoReviewProps) => {
  const t = useTranslations();
  const { review, sourceTruncated } = extraction;

  if (review.results) {
    return <ImportResultsList results={review.results} />;
  }

  return (
    <>
      {sourceTruncated && (
        <p className="bg-warning/10 text-warning-foreground flex items-start gap-2 rounded-md p-3 text-xs">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
          {t("contacts.extractProcuracao.sourceTruncated")}
        </p>
      )}
      {review.validation.status === "failed" && (
        <p className="text-destructive flex items-start gap-2 text-xs">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
          {review.validation.message}
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        {t("contacts.import.previewSummary", {
          invalid: review.errorCount,
          valid: review.validCount,
        })}
      </p>
      {review.rows.map((row, index) => (
        <ImportCandidateCard
          fields={PROCURACAO_REVIEW_FIELDS}
          key={row.id}
          onChange={(candidate) => review.updateRow(row.id, candidate)}
          onRemove={() => review.removeRow(row.id)}
          ordinal={index + 1}
          row={row}
        />
      ))}
    </>
  );
};
