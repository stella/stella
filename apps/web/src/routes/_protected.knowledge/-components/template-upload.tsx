import { useCallback, useRef, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { toastManager } from "@stll/ui/components/toast";
import { UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors";

type DiscoverResponse = Awaited<ReturnType<typeof api.templates.discover.post>>;

type DiscoverData = Exclude<
  NonNullable<Extract<DiscoverResponse, { data: unknown }>["data"]>,
  Response
>;

type TemplateUploadProps = {
  onDiscovered: (file: File, schema: DiscoverData) => void;
};

export const TemplateUpload = ({ onDiscovered }: TemplateUploadProps) => {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const discover = useCallback(
    async (file: File) => {
      if (file.type !== DOCX_MIME) {
        toastManager.add({
          type: "error",
          title: t("templates.invalidFileType"),
        });
        return;
      }

      setLoading(true);
      const response = await api.templates.discover.post({
        file,
      });

      setLoading(false);

      if (response.error) {
        toastManager.add({
          type: "error",
          title: t("templates.discoveryFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }

      const { data } = response;
      if (data instanceof Response) {
        toastManager.add({
          type: "error",
          title: t("templates.discoveryFailed"),
        });
        return;
      }

      onDiscovered(file, data);
    },
    [onDiscovered, t],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.item(0);
      if (file) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        discover(file);
      }
      // Reset so the same file can be re-selected
      e.target.value = "";
    },
    [discover],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files.item(0);
      if (file) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        discover(file);
      }
    },
    [discover],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className={`flex w-full max-w-md flex-col items-center gap-4 rounded-xl border-2 border-dashed p-10 transition-[border-color,background-color,box-shadow] duration-200 ${
          isDragOver
            ? "border-foreground/30 bg-accent/50 shadow-primary/20 shadow-lg"
            : "border-border shadow-none"
        }`}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className="bg-muted flex size-12 items-center justify-center rounded-lg">
          <UploadIcon className="text-muted-foreground size-6" />
        </div>

        <div className="text-center">
          <h2 className="text-base font-semibold">
            {t("templates.uploadTitle")}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {t("templates.uploadDescription")}
          </p>
        </div>

        <div className="flex flex-col items-center gap-2">
          <Button disabled={loading} onClick={() => inputRef.current?.click()}>
            {loading ? t("templates.discovering") : t("templates.browseFiles")}
          </Button>
          <p className="text-muted-foreground text-xs">
            {t("templates.dragAndDrop")}
          </p>
        </div>

        <input
          accept=".docx"
          className="hidden"
          onChange={handleFileChange}
          ref={inputRef}
          type="file"
        />
      </div>
    </div>
  );
};
