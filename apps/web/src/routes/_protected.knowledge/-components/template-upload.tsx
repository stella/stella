import { useCallback, useRef, useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { UploadIcon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { toAPIError, userErrorFromThrown } from "@/lib/errors";

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
  const prepareInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const discoverMutation = useMutation({
    mutationFn: async (file: File) => {
      const response = await api.templates.discover.post({ file });
      if (response.error) {
        throw toAPIError(response.error);
      }
      const { data } = response;
      if (data instanceof Response) {
        throw new TypeError("Unexpected response shape");
      }
      return { file, data };
    },
    onSuccess: ({ file, data }) => {
      onDiscovered(file, data);
    },
    onError: (error) => {
      stellaToast.add({
        type: "error",
        title: t("templates.discoveryFailed"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
      });
    },
  });
  // "Prepare with AI": the model marks up a finished document into a template,
  // then we discover the result so it flows into the same configure step,
  // pre-filled with the suggested fields (types + AI prompts ride in the
  // embedded manifest and are preserved on create).
  const prepareMutation = useMutation({
    mutationFn: async (file: File) => {
      const response = await api.templates.prepare.post({ file });
      if (response.error) {
        throw toAPIError(response.error);
      }
      // /prepare returns the marked-up docx as base64 JSON (binary responses
      // get corrupted by Eden); decode it back to bytes, then discover.
      const bytes = Uint8Array.from(
        atob(response.data.docxBase64),
        (ch) => ch.codePointAt(0) ?? 0,
      );
      const prepared = new File([bytes], file.name, { type: DOCX_MIME });
      const discovered = await api.templates.discover.post({ file: prepared });
      if (discovered.error) {
        throw toAPIError(discovered.error);
      }
      const { data } = discovered;
      if (data instanceof Response) {
        throw new TypeError("Unexpected response shape");
      }
      return { file: prepared, data };
    },
    onSuccess: ({ file, data }) => {
      onDiscovered(file, data);
    },
    onError: (error) => {
      stellaToast.add({
        type: "error",
        title: t("templates.discoveryFailed"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
      });
    },
  });

  const loading = discoverMutation.isPending || prepareMutation.isPending;

  const mutateDiscover = discoverMutation.mutate;
  const discover = useCallback(
    (file: File) => {
      if (file.type !== DOCX_MIME) {
        stellaToast.add({
          type: "error",
          title: t("templates.invalidFileType"),
        });
        return;
      }
      mutateDiscover(file);
    },
    [mutateDiscover, t],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.item(0);
      if (file) {
        discover(file);
      }
      // Reset so the same file can be re-selected
      e.target.value = "";
    },
    [discover],
  );

  const mutatePrepare = prepareMutation.mutate;
  const handlePrepareFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.item(0);
      if (file) {
        if (file.type !== DOCX_MIME) {
          stellaToast.add({
            type: "error",
            title: t("templates.invalidFileType"),
          });
        } else {
          mutatePrepare(file);
        }
      }
      e.target.value = "";
    },
    [mutatePrepare, t],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files.item(0);
      if (file) {
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
          <div className="flex items-center gap-2">
            <Button
              disabled={loading}
              onClick={() => inputRef.current?.click()}
            >
              {loading
                ? t("templates.discovering")
                : t("templates.browseFiles")}
            </Button>
            <Button
              disabled={loading}
              onClick={() => prepareInputRef.current?.click()}
              variant="outline"
            >
              <WandSparklesIcon />
              {t("templates.studio.prepareWithAi")}
            </Button>
          </div>
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
        <input
          accept=".docx"
          className="hidden"
          onChange={handlePrepareFileChange}
          ref={prepareInputRef}
          type="file"
        />
      </div>
    </div>
  );
};
