import { useCallback, useRef, useState } from "react";
import { UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stella/ui/components/dialog";
import { toastManager } from "@stella/ui/components/toast";

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
          const parsed = JSON.parse(text) as {
            clauses?: unknown[];
          };
          setPreviewCount(
            Array.isArray(parsed.clauses) ? parsed.clauses.length : 0,
          );
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
      toastManager.add({
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
      toastManager.add({
        type: "error",
        title: t("clauses.importFailed"),
      });
      return;
    }

    setResult(data);
    toastManager.add({
      type: "success",
      title: t("clauses.importSuccess", {
        count: data.created,
      }),
    });

    onImported();
  }, [file, t, onImported]);

  const handleClose = useCallback(
    (open: boolean) => {
      if (!open) {
        setFile(null);
        setPreviewCount(null);
        setResult(null);
      }
      onOpenChange(open);
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
            <UploadIcon className="size-8 text-muted-foreground" />
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
              <p className="text-sm text-muted-foreground">
                {file.name}
                {previewCount !== null &&
                  ` (${t("clauses.clauseCount", { count: previewCount })})`}
              </p>
            )}
          </div>

          {result && (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <p>
                {t("clauses.importResult", {
                  created: result.created,
                  skipped: result.skipped,
                })}
              </p>
              {result.errors.length > 0 && (
                <ul className="mt-2 list-inside list-disc text-destructive-foreground">
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
            <Button disabled={!file || importing} onClick={handleImport}>
              {importing ? t("clauses.importing") : t("clauses.import")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
