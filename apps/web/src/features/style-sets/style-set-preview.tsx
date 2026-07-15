import type { CSSProperties } from "react";

import { useTranslations } from "use-intl";

import type {
  NumberedParagraphStyleSettings,
  ParagraphStyleSettings,
  StyleSetEditorSettings,
} from "@/features/style-sets/style-set-editor-types";
import {
  previewLineHeight,
  previewNumberingMarkers,
  previewPaperRatio,
} from "@/features/style-sets/style-set-preview.logic";

const PREVIEW_WIDTH_PX = 520;
const PREVIEW_POINTS_SCALE = 0.78;
const PREVIEW_BODY_TRANSLATION_KEY = "styleSets.editor.previewBody";

export const StyleSetPreview = ({
  settings,
}: {
  settings: StyleSetEditorSettings;
}) => {
  const t = useTranslations();
  const markers = previewNumberingMarkers(settings);
  const ratio = previewPaperRatio(settings.page);
  const width = PREVIEW_WIDTH_PX;
  const height = width * ratio;
  const pageStyle = {
    width,
    minHeight: height,
    paddingBlockStart: settings.page.marginTopPt * PREVIEW_POINTS_SCALE,
    paddingBlockEnd: settings.page.marginBottomPt * PREVIEW_POINTS_SCALE,
    paddingInlineStart: settings.page.marginLeftPt * PREVIEW_POINTS_SCALE,
    paddingInlineEnd: settings.page.marginRightPt * PREVIEW_POINTS_SCALE,
    fontFamily: settings.body.fontFamily,
    fontSize: `${settings.body.fontSizePt * PREVIEW_POINTS_SCALE}px`,
    lineHeight: previewLineHeight(settings.body.lineSpacing),
    textAlign: previewAlignment(settings.body.alignment, "justify"),
  } satisfies CSSProperties;

  return (
    <section
      aria-label={t("common.preview")}
      className="bg-muted/48 flex min-h-full items-start justify-center overflow-auto p-6 sm:p-10"
    >
      <article
        className="bg-background text-foreground border-border shrink-0 border shadow-sm"
        dir="ltr"
        style={pageStyle}
      >
        <PreviewParagraph className="text-balance" settings={settings.title}>
          {t("styleSets.editor.previewTitle")}
        </PreviewParagraph>
        <p className="text-pretty" style={bodySpacing(settings)}>
          {t("styleSets.editor.previewIntroduction")}
        </p>
        <NumberedPreviewParagraph
          marker={markers.level1}
          settings={settings.level1}
        >
          {t("styleSets.editor.previewLevel1")}
        </NumberedPreviewParagraph>
        <p className="text-pretty" style={bodySpacing(settings)}>
          {t(PREVIEW_BODY_TRANSLATION_KEY)}
        </p>
        <NumberedPreviewParagraph
          marker={markers.level2}
          settings={settings.level2}
        >
          {t("styleSets.editor.previewLevel2")}
        </NumberedPreviewParagraph>
        <p className="text-pretty" style={bodySpacing(settings)}>
          {t(PREVIEW_BODY_TRANSLATION_KEY)}
        </p>
        <NumberedPreviewParagraph
          marker={markers.level3}
          settings={settings.level3}
        >
          {t("styleSets.editor.previewLevel3")}
        </NumberedPreviewParagraph>
        <p className="text-pretty" style={bodySpacing(settings)}>
          {t(PREVIEW_BODY_TRANSLATION_KEY)}
        </p>
      </article>
    </section>
  );
};

const PreviewParagraph = ({
  settings,
  children,
  className,
}: {
  settings: ParagraphStyleSettings;
  children: string;
  className?: string | undefined;
}) => (
  <p className={className} style={paragraphStyle(settings)}>
    {children}
  </p>
);

const NumberedPreviewParagraph = ({
  settings,
  marker,
  children,
}: {
  settings: NumberedParagraphStyleSettings;
  marker: string;
  children: string;
}) => (
  <div
    className="grid"
    style={{
      gridTemplateColumns: marker === "" ? "0 1fr" : "auto 1fr",
      columnGap: `${settings.hangingPt * PREVIEW_POINTS_SCALE}px`,
      marginInlineStart: `${Math.max(0, settings.indentLeftPt - settings.hangingPt) * PREVIEW_POINTS_SCALE}px`,
    }}
  >
    <span
      aria-hidden="true"
      className="tabular-nums"
      style={paragraphStyle(settings)}
    >
      {marker}
    </span>
    <PreviewParagraph settings={settings}>{children}</PreviewParagraph>
  </div>
);

const paragraphStyle = (settings: ParagraphStyleSettings): CSSProperties => ({
  fontFamily: settings.fontFamily,
  fontSize: `${settings.fontSizePt * PREVIEW_POINTS_SCALE}px`,
  fontWeight: settings.bold ? 700 : 400,
  textAlign: previewAlignment(settings.alignment, "start"),
  marginBlockStart: `${settings.spaceBeforePt * PREVIEW_POINTS_SCALE}px`,
  marginBlockEnd: `${settings.spaceAfterPt * PREVIEW_POINTS_SCALE}px`,
});

const previewAlignment = (
  alignment: ParagraphStyleSettings["alignment"],
  fallback: CSSProperties["textAlign"],
): CSSProperties["textAlign"] => {
  if (alignment === "both") {
    return "justify";
  }
  if (alignment === "left" || alignment === "center" || alignment === "right") {
    return alignment;
  }
  return fallback;
};

const bodySpacing = (settings: StyleSetEditorSettings): CSSProperties => ({
  marginBlockEnd: `${settings.body.spaceAfterPt * PREVIEW_POINTS_SCALE}px`,
});
