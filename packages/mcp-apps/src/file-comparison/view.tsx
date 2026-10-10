import { useSyncExternalStore } from "react";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { IntlProvider, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { FileInput } from "@stll/ui/file-input";
import { Label } from "@stll/ui/label";
import { cn } from "@stll/ui/utils";

import type { createFileComparisonRuntime } from "./runtime";

type FileComparisonProps = {
  runtime: ReturnType<typeof createFileComparisonRuntime>;
};
const Content = ({ runtime }: FileComparisonProps) => {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const t = useTranslations();
  return (
    <main
      aria-labelledby="title"
      className="bg-background text-foreground grid gap-3 p-4"
    >
      <h1 id="title" className="text-base font-semibold">
        {t("comparisonTitle")}
      </h1>
      <p className="text-muted-foreground text-sm">{t("comparisonNote")}</p>
      <section className="grid gap-2">
        <Label id="base-label">{t("originalFile")}</Label>
        <FileInput
          aria-labelledby="base-label"
          disabled={snapshot.uploadPhase === "active"}
          file={snapshot.base}
          onFileChange={runtime.selectBase}
          chooseLabel={t("chooseFile")}
          emptyLabel={t("noFile")}
          accept=".docx"
        />
      </section>
      <section className="grid gap-2">
        <Label id="target-label">{t("revisedFile")}</Label>
        <FileInput
          aria-labelledby="target-label"
          disabled={snapshot.uploadPhase === "active"}
          file={snapshot.target}
          onFileChange={runtime.selectTarget}
          chooseLabel={t("chooseFile")}
          emptyLabel={t("noFile")}
          accept=".docx"
        />
      </section>

      <Button
        id="upload"
        disabled={
          snapshot.uploadPhase === "active" ||
          !snapshot.base ||
          !snapshot.target
        }
        onClick={() => runtime.upload()}
      >
        {t("uploadForRedline")}
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
export const FileComparison = ({ runtime }: FileComparisonProps) => {
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
