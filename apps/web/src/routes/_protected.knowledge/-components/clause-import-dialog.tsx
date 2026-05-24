import { useCallback, useRef, useState } from "react";

import { UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";

type ImportResult = {
  created: number;
  skipped: number;
  errors: string[];
};

type ClauseImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
};

export const ClauseImportDialog = ({
  open,
  onOpenChange,
  onImported,
}: ClauseImportDialogProps) => {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.item(0);
      if (!selected) {
        return;
      }

      setFile(selected);
      setResult(null);

      // Preview: parse to count clauses
      selected
        .text()
        .then((text) => {
          const parsed: unknown = JSON.parse(text);
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            !("clauses" in parsed)
          ) {
            setPreviewCount(0);
            return;
          }
          const { clauses } = parsed;
          setPreviewCount(Array.isArray(clauses) ? clauses.length : 0);
          return;
        })
        .catch(() => {
          setPreviewCount(null);
        });

      // Reset so the same file can be re-selected
      e.target.value = "";
    },
    [],
  );

  const handleImport = useCallback(async () => {
    if (!file) {
      return;
    }

    setImporting(true);
    const response = await api.clauses.import.put({
      file,
    });
    setImporting(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("clauses.importFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    const data = response.data;
    if (data instanceof Response) {
      stellaToast.add({
        type: "error",
        title: t("clauses.importFailed"),
      });
      return;
    }

    setResult(data);
    stellaToast.add({
      type: "success",
      title: t("clauses.importSuccess", {
        count: data.created,
      }),
    });

    onImported();
  }, [file, t, onImported]);

  const handleClose = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        setFile(null);
        setPreviewCount(null);
        setResult(null);
      }
      onOpenChange(isOpen);
    },
    [onOpenChange],
  );

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("clauses.import")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-6">
            <UploadIcon className="text-muted-foreground size-8" />
            <Button
              onClick={() => inputRef.current?.click()}
              size="sm"
              variant="outline"
            >
              {t("clauses.selectFile")}
            </Button>
            <input
              accept=".json"
              className="hidden"
              onChange={handleFileChange}
              ref={inputRef}
              type="file"
            />
            {file && (
              <p className="text-muted-foreground text-sm">
                {file.name}
                {previewCount !== null &&
                  ` (${t("clauses.clauseCount", { count: previewCount })})`}
              </p>
            )}
          </div>

          {result && (
            <div className="bg-muted/30 rounded-lg border p-3 text-sm">
              <p>
                {t("clauses.importResult", {
                  created: result.created,
                  skipped: result.skipped,
                })}
              </p>
              {result.errors.length > 0 && (
                <ul className="text-destructive-foreground mt-2 list-inside list-disc">
                  {result.errors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          {!result && (
            <Button
              disabled={!file || importing}
              onClick={() => {
                void handleImport();
              }}
            >
              {importing ? t("clauses.importing") : t("clauses.import")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
