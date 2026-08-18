import { useRef, useState } from "react";
import type { RefObject } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { AlertTriangleIcon, UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { stellaToast } from "@stll/ui/components/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { isDocxFile } from "@/lib/consts";
import { useImportContacts } from "@/lib/contacts/mutations";
import { contactsKeys } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
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

type ExtractProcuracaoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const EXTRACTION_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
const EXTRACTION_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export const ExtractProcuracaoDialog = ({
  open,
  onOpenChange,
}: ExtractProcuracaoDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const handleFileChange = async (file: File) => {
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

  const handleConfirm = async () => {
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

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          reset();
        }
      }}
      open={open}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("contacts.extractProcuracao.dialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {results
              ? t("contacts.import.resultsSummary", {
                  created: results.filter((r) => r.status === "created").length,
                  skipped: results.filter((r) => r.status === "skipped").length,
                })
              : t("contacts.extractProcuracao.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          <ExtractProcuracaoDialogBody
            fileInputRef={fileInputRef}
            invalidCount={invalidCount}
            isExtracting={isExtracting}
            onFieldChange={updateField}
            onFileChange={(file) =>
              detached(
                handleFileChange(file),
                "contact-extract-procuracao.upload",
              )
            }
            onRemoveRow={removeRow}
            results={results}
            rows={rows}
            sourceTruncated={sourceTruncated}
            validCount={validRowVars.length}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t(results ? "common.close" : "common.cancel")}
          </DialogClose>
          {!results && rows.length > 0 && (
            <Button
              disabled={validRowVars.length === 0 || !importRequestId}
              loading={importContacts.isPending}
              onClick={() =>
                detached(handleConfirm(), "contact-extract-procuracao.confirm")
              }
              type="button"
            >
              {t("contacts.import.confirmAction")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type ExtractProcuracaoDialogBodyProps = {
  isExtracting: boolean;
  results: ImportContactResult[] | null;
  rows: ParsedImportRow[];
  sourceTruncated: boolean;
  validCount: number;
  invalidCount: number;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileChange: (file: File) => void;
  onFieldChange: (
    rowIndex: number,
    key: ParsedImportFieldKey,
    value: string,
  ) => void;
  onRemoveRow: (rowIndex: number) => void;
};

const ExtractProcuracaoDialogBody = ({
  isExtracting,
  results,
  rows,
  sourceTruncated,
  validCount,
  invalidCount,
  fileInputRef,
  onFileChange,
  onFieldChange,
  onRemoveRow,
}: ExtractProcuracaoDialogBodyProps) => {
  const t = useTranslations();
  const truncationWarning = sourceTruncated ? (
    <p className="bg-warning/10 text-warning-foreground flex items-start gap-2 rounded-md p-3 text-xs">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
      {t("contacts.extractProcuracao.sourceTruncated")}
    </p>
  ) : null;

  if (results) {
    return <ImportResultsList results={results} />;
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2">
        {truncationWarning}
        <Button
          disabled={isExtracting}
          loading={isExtracting}
          onClick={() => fileInputRef.current?.click()}
          size="sm"
          type="button"
          variant="outline"
        >
          <UploadIcon className="size-3.5" />
          {t("contacts.extractProcuracao.chooseFile")}
        </Button>
        <span className="text-muted-foreground text-xs">
          {t("contacts.extractProcuracao.fileHint")}
        </span>
        <input
          accept=".docx"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) {
              return;
            }
            onFileChange(file);
            event.target.value = "";
          }}
          ref={fileInputRef}
          type="file"
        />
      </div>
    );
  }

  return (
    <>
      {truncationWarning}
      <p className="text-muted-foreground text-xs">
        {t("contacts.import.previewSummary", {
          valid: validCount,
          invalid: invalidCount,
        })}
      </p>
      {rows.map((row) => (
        <ImportRowCard
          key={row.rowIndex}
          onFieldChange={(key, value) =>
            onFieldChange(row.rowIndex, key, value)
          }
          onRemove={() => onRemoveRow(row.rowIndex)}
          row={row}
        />
      ))}
    </>
  );
};
