import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { AlertTriangleIcon, FileTextIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useExternalFileDrop } from "@/hooks/use-external-file-drop";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { isDocxFile } from "@/lib/consts";
import { useImportContacts } from "@/lib/contacts/mutations";
import { contactsKeys } from "@/lib/contacts/queries";
import { toAPIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { fetchWithTimeout } from "@/lib/fetch";
import { sha256Hex } from "@/lib/files/sha256";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import {
  ImportResultsList,
  ImportRowCard,
} from "@/routes/_protected.contacts/-import-dialog";
import type { ImportContactResult } from "@/routes/_protected.contacts/-import-dialog";
import {
  assignStableImportIds,
  toImportRowVars,
  validateRows,
} from "@/routes/_protected.contacts/-parse-import";
import type {
  ParsedImportFieldKey,
  ParsedImportRow,
} from "@/routes/_protected.contacts/-parse-import";
import { candidatesToRows } from "@/routes/_protected.contacts/-parse-procuracao";

const EXTRACTION_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
const EXTRACTION_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Where the procuração flow currently sits, as seen by the host dialog:
 * `idle` shows the drop zone (plus whatever else the host renders),
 * `review` shows editable outorgante rows, `done` shows the import receipt.
 */
export type ProcuracaoExtractionStage = "idle" | "review" | "done";

type ProcuracaoExtractionState = {
  stage: ProcuracaoExtractionStage;
  isExtracting: boolean;
  isConfirming: boolean;
  rows: ParsedImportRow[];
  results: ImportContactResult[] | null;
  sourceTruncated: boolean;
  validCount: number;
  invalidCount: number;
  canConfirm: boolean;
  extractFile: (file: File) => Promise<void>;
  updateField: (
    rowIndex: number,
    key: ParsedImportFieldKey,
    value: string,
  ) => void;
  removeRow: (rowIndex: number) => void;
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
  const importContacts = useImportContacts();

  const [isExtracting, setIsExtracting] = useState(false);
  const [rows, setRows] = useState<ParsedImportRow[]>([]);
  const [results, setResults] = useState<ImportContactResult[] | null>(null);
  const [sourceTruncated, setSourceTruncated] = useState(false);
  const [importRequestId, setImportRequestId] =
    useState<SafeId<"contactImportRequest"> | null>(null);

  const reset = () => {
    setIsExtracting(false);
    setRows([]);
    setResults(null);
    setSourceTruncated(false);
    setImportRequestId(null);
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

    setResults(null);
    setImportRequestId(toSafeId<"contactImportRequest">(crypto.randomUUID()));
    setRows(assignStableImportIds(candidatesToRows(outorgantes)));
  };

  const updateField = (
    rowIndex: number,
    key: ParsedImportFieldKey,
    value: string,
  ) => {
    setRows((prev) =>
      assignStableImportIds(
        validateRows(
          prev.map((row) =>
            row.rowIndex === rowIndex
              ? { ...row, fields: { ...row.fields, [key]: value } }
              : row,
          ),
        ),
        prev,
      ),
    );
  };

  const removeRow = (rowIndex: number) => {
    setRows((prev) =>
      assignStableImportIds(
        validateRows(prev.filter((row) => row.rowIndex !== rowIndex)),
        prev,
      ),
    );
  };

  const validRows = rows.flatMap((row) => {
    const vars = toImportRowVars(row);
    return vars ? [{ originalRowIndex: row.rowIndex, vars }] : [];
  });
  const validRowVars = validRows.map(({ vars }) => vars);
  const invalidCount = rows.length - validRowVars.length;

  const confirm = async () => {
    if (!importRequestId) {
      return;
    }
    try {
      const importResults = await importContacts.mutateAsync({
        importRequestId,
        rows: validRowVars,
      });
      setResults(
        importResults.map((result) => {
          const index =
            validRows.at(result.index)?.originalRowIndex ?? result.index;
          if (result.status === "created") {
            return {
              index,
              status: result.status,
              contactId: result.contactId,
            };
          }
          return { index, status: result.status, reason: result.reason };
        }),
      );
      setRows([]);
      await queryClient.invalidateQueries({ queryKey: contactsKeys.all });
    } catch (error) {
      getAnalytics().captureError(error);
      stellaToast.add({
        title: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    }
  };

  const stage = resolveStage({ results, rowCount: rows.length });

  return {
    stage,
    isExtracting,
    isConfirming: importContacts.isPending,
    rows,
    results,
    sourceTruncated,
    validCount: validRowVars.length,
    invalidCount,
    canConfirm: validRowVars.length > 0 && importRequestId !== null,
    extractFile,
    updateField,
    removeRow,
    confirm,
    reset,
  };
};

const resolveStage = ({
  results,
  rowCount,
}: {
  results: ImportContactResult[] | null;
  rowCount: number;
}): ProcuracaoExtractionStage => {
  if (results) {
    return "done";
  }
  if (rowCount > 0) {
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
  extraction: Pick<
    ProcuracaoExtractionState,
    | "invalidCount"
    | "removeRow"
    | "results"
    | "rows"
    | "sourceTruncated"
    | "updateField"
    | "validCount"
  >;
};

/** Editable outorgante rows before confirmation, or the receipt after it. */
export const ProcuracaoReview = ({ extraction }: ProcuracaoReviewProps) => {
  const t = useTranslations();
  const {
    invalidCount,
    removeRow,
    results,
    rows,
    sourceTruncated,
    updateField,
    validCount,
  } = extraction;

  if (results) {
    return <ImportResultsList results={results} />;
  }

  return (
    <>
      {sourceTruncated && (
        <p className="bg-warning/10 text-warning-foreground flex items-start gap-2 rounded-md p-3 text-xs">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
          {t("contacts.extractProcuracao.sourceTruncated")}
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        {t("contacts.import.previewSummary", {
          valid: validCount,
          invalid: invalidCount,
        })}
      </p>
      {rows.map((row) => (
        <ImportRowCard
          key={row.rowIndex}
          onFieldChange={(key, value) => updateField(row.rowIndex, key, value)}
          onRemove={() => removeRow(row.rowIndex)}
          row={row}
        />
      ))}
    </>
  );
};
