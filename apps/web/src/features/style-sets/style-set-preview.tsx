import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import "@stll/folio-react/editor.css";

import { DocxLoadingShell } from "@/components/docx/docx-loading-shell";
import type { StyleSetEditorSettings } from "@/features/style-sets/style-set-editor-types";
import {
  styleSetPreviewOptions,
  type StyleSetPreviewContent,
  type StyleSetPreviewSource,
} from "@/features/style-sets/style-set-queries";

const DocxEditor = lazy(async () => {
  const module = await import("@/components/docx/app-docx-editor");
  return { default: module.DocxEditor };
});

const PREVIEW_DEBOUNCE_MS = 250;

type StyleSetPreviewProps = {
  organizationId: string;
  settings: StyleSetEditorSettings;
  source: StyleSetPreviewSource;
};

export const StyleSetPreview = ({
  organizationId,
  settings,
  source,
}: StyleSetPreviewProps) => {
  const t = useTranslations();
  const [debouncedSettings] = useDebounce(settings, PREVIEW_DEBOUNCE_MS);
  const content = {
    title: t("styleSets.editor.previewTitle"),
    introduction: t("styleSets.editor.previewIntroduction"),
    investmentHeading: t("styleSets.editor.previewLevel1"),
    investmentBody: t("styleSets.editor.previewBody"),
    equityFinancingHeading: t("styleSets.editor.previewLevel2"),
    equityFinancingBody: t("styleSets.editor.previewBody2"),
    conversionPriceHeading: t("styleSets.editor.previewLevel3"),
    conversionPriceBody: t("styleSets.editor.previewBody3"),
    shareClassHeading: t("styleSets.editor.previewLevel3Second"),
    shareClassBody: t("styleSets.editor.previewBody4"),
    liquidityEventHeading: t("styleSets.editor.previewLevel2Second"),
    liquidityEventBody: t("styleSets.editor.previewBody5"),
    companyRepresentationsHeading: t("styleSets.editor.previewLevel1Second"),
    companyRepresentationsBody: t("styleSets.editor.previewBody6"),
    generalHeading: t("styleSets.editor.previewLevel1Third"),
    generalBody: t("styleSets.editor.previewBody7"),
  } satisfies StyleSetPreviewContent;
  const preview = useQuery(
    styleSetPreviewOptions({
      organizationId,
      source,
      settings: debouncedSettings,
      content,
    }),
  );
  let previewResult: ReactNode;
  if (preview.isError) {
    previewResult = (
      <div className="text-muted-foreground m-auto px-6 text-center text-sm">
        {t("styleSets.editor.previewFailed")}
      </div>
    );
  } else if (preview.data === undefined) {
    previewResult = <DocxLoadingShell />;
  } else {
    previewResult = (
      <Suspense fallback={<DocxLoadingShell />}>
        <DocxEditor
          autoOpenReviewSidebar={false}
          className="folio-docx-preview h-full"
          documentBuffer={preview.data}
          enableWheelZoom={false}
          initialZoom="fit-width"
          loadingIndicator={<DocxLoadingShell />}
          mode="viewing"
          preserveDocumentWhileLoading
          readOnly
          showHeaderFooterEditing={false}
          showPrintButton={false}
          showReviewControls={false}
          showToolbar={false}
          showZoomControl={false}
        />
      </Suspense>
    );
  }

  return (
    <section
      aria-label={t("common.preview")}
      className="bg-muted/48 flex min-h-0 overflow-hidden"
    >
      {previewResult}
    </section>
  );
};
