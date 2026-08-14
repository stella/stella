import { useRef, useState } from "react";
import type { RefObject } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { UploadIcon } from "lucide-react";
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
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  ImportResultsList,
  ImportRowCard,
} from "@/routes/_protected.contacts/-import-dialog";
import type { ImportContactResult } from "@/routes/_protected.contacts/-import-dialog";
import {
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

  const reset = () => {
    setIsExtracting(false);
    setRows([]);
    setResults(null);
  };

  const handleFileChange = async (file: File) => {
    if (!isDocxFile(file)) {
      stellaToast.add({
        title: t("contacts.extractProcuracao.invalidFileType"),
        type: "error",
      });
      return;
    }

    setIsExtracting(true);
    try {
      const response = await api.contacts["extract-from-procuracao"].post({
        file,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      const { outorgantes } = response.data;
      if (outorgantes.length === 0) {
        stellaToast.add({
          title: t("contacts.extractProcuracao.noOutorganteFound"),
          type: "info",
        });
        return;
      }

      setResults(null);
      setRows(candidatesToRows(outorgantes));
    } catch (error) {
      getAnalytics().captureError(error);
      stellaToast.add({
        title: userErrorFromThrown(
          error,
          t("contacts.extractProcuracao.parseErrorGeneric"),
        ),
        type: "error",
      });
    } finally {
      setIsExtracting(false);
    }
  };

  const updateField = (
    rowIndex: number,
    key: ParsedImportFieldKey,
    value: string,
  ) => {
    setRows((prev) =>
      validateRows(
        prev.map((row) =>
          row.rowIndex === rowIndex
            ? { ...row, fields: { ...row.fields, [key]: value } }
            : row,
        ),
      ),
    );
  };

  const removeRow = (rowIndex: number) => {
    setRows((prev) =>
      validateRows(prev.filter((row) => row.rowIndex !== rowIndex)),
    );
  };

  const validRowVars = rows
    .map((row) => toImportRowVars(row))
    .filter((vars) => vars !== null);
  const invalidCount = rows.length - validRowVars.length;

  const handleConfirm = async () => {
    try {
      const importResults = await importContacts.mutateAsync({
        rows: validRowVars,
      });
      setResults(importResults);
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
                  created: String(
                    results.filter((r) => r.status === "created").length,
                  ),
                  skipped: String(
                    results.filter((r) => r.status === "skipped").length,
                  ),
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
            validCount={validRowVars.length}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t(results ? "common.close" : "common.cancel")}
          </DialogClose>
          {!results && rows.length > 0 && (
            <Button
              disabled={validRowVars.length === 0}
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
  validCount,
  invalidCount,
  fileInputRef,
  onFileChange,
  onFieldChange,
  onRemoveRow,
}: ExtractProcuracaoDialogBodyProps) => {
  const t = useTranslations();

  if (results) {
    return <ImportResultsList results={results} />;
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2">
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
      <p className="text-muted-foreground text-xs">
        {t("contacts.import.previewSummary", {
          valid: String(validCount),
          invalid: String(invalidCount),
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
