import { useSyncExternalStore } from "react";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { IntlProvider, useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { FileInput } from "@stll/ui/file-input";
import { Label } from "@stll/ui/label";
import { cn } from "@stll/ui/utils";

import type { createDocumentUploadRuntime } from "./runtime";

type DocumentUploadProps = {
  runtime: ReturnType<typeof createDocumentUploadRuntime>;
};
const Content = ({ runtime }: DocumentUploadProps) => {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const t = useTranslations();
  return (
    <main
      aria-labelledby="title"
      className="bg-background text-foreground grid gap-3 p-4"
    >
      <h1 id="title" className="text-base font-semibold">
        {t("uploadTitle")}
      </h1>
      <p id="target" className="text-muted-foreground text-sm">
        <BidiText value={snapshot.targetLabel} />
      </p>
      <section className="grid gap-2">
        <Label id="file-label">{t("file")}</Label>
        <FileInput
          aria-labelledby="file-label"
          disabled={snapshot.uploadPhase === "active"}
          file={snapshot.file}
          onFileChange={runtime.selectFile}
          chooseLabel={t("chooseFile")}
          emptyLabel={t("noFile")}
        />
      </section>

      <Button
        id="upload"
        disabled={
          snapshot.uploadPhase === "active" ||
          !snapshot.file ||
          !snapshot.uploadTarget
        }
        onClick={() => runtime.upload()}
      >
        {t("uploadVersion")}
      </Button>
      <p
        id="status"
        role="status"
        aria-live="polite"
        className={cn(
          "min-h-5 text-sm",
          snapshot.status === "error" && "text-destructive",
          snapshot.status === "success" && "text-foreground",
        )}
      >
        {snapshot.message}
      </p>
    </main>
  );
};
export const DocumentUpload = ({ runtime }: DocumentUploadProps) => {
  const { locale } = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
  );
  return (
    <IntlProvider locale={locale.formattingLocale} messages={locale.messages}>
      <DirectionProvider direction={locale.direction}>
        <Content runtime={runtime} />
      </DirectionProvider>
    </IntlProvider>
  );
};
