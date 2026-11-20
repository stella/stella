import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { ScrollArea } from "@stll/ui/scroll-area";

import { PendingText } from "@/components/pending-text";

// A catalogue template's page in both phases (a pending-safe module): the
// loaded view renders these frames with the template, the pending view with
// placeholders, so the two cannot drift.

/** The page's column, its title block and the actions beside it. */
export const TemplateCatalogueDetailFrame = ({
  title,
  packName,
  actions,
  children,
}: {
  title: ReactNode;
  packName: ReactNode;
  actions?: ReactNode;
  /** The facts, the fields and the preview, in that order. */
  children: ReactNode;
}) => (
  <ScrollArea axis="vertical" className="flex-1">
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 py-7 sm:px-7 sm:py-9">
      <header className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight" dir="auto">
            {title}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm" dir="auto">
            {packName}
          </p>
        </div>
        {actions !== undefined && actions !== null && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </header>
      {children}
    </div>
  </ScrollArea>
);

/** The rendered template's box under its heading. */
export const TemplateCataloguePreviewFrame = ({
  heading,
  children,
}: {
  heading: ReactNode;
  children: ReactNode;
}) => (
  <section aria-labelledby="catalogue-template-preview">
    <h2
      className="mb-3 text-base font-semibold"
      id="catalogue-template-preview"
    >
      {heading}
    </h2>
    <div className="rounded-xl border px-4">{children}</div>
  </section>
);

// One width per placeholder line, which also keys it.
const PREVIEW_LINE_WIDTHS = ["w-1/3", "w-full", "w-11/12", "w-5/6", "w-3/4"];

/** The preview's paragraphs before they are rendered, at their spacing. */
export const TemplateCataloguePreviewPending = () => (
  <div aria-hidden="true" className="space-y-0.5 py-2">
    {PREVIEW_LINE_WIDTHS.map((width) => (
      <div className="py-1 leading-relaxed" key={width}>
        <FaceLabelPending className={width} />
      </div>
    ))}
  </div>
);

/**
 * The page before the template has been read: its title block, the actions
 * every visitor is offered, the licence and the preview, each holding its
 * place.
 */
export const TemplateCatalogueDetailPending = () => (
  <TemplateCatalogueDetailFrame
    actions={
      <>
        <ButtonFace size="sm" variant="default">
          <PendingText barClassName="w-20" id="templates.useTemplate" />
        </ButtonFace>
        <ButtonFace size="sm" variant="outline">
          <PendingText
            barClassName="w-24"
            id="knowledge.catalogue.addToLibrary"
          />
        </ButtonFace>
        <ButtonFace size="sm" variant="outline">
          <PendingText barClassName="w-14" id="common.download" />
        </ButtonFace>
      </>
    }
    packName={<FaceLabelPending className="w-32" />}
    title={<FaceLabelPending className="w-72 max-w-full" />}
  >
    <DetailsGrid>
      <DetailsItem
        label={
          <PendingText
            barClassName="w-14"
            id="onboarding.catalogueDetailLicense"
          />
        }
      >
        <FaceLabelPending className="w-12" />
      </DetailsItem>
    </DetailsGrid>
    <TemplateCataloguePreviewFrame
      heading={<PendingText barClassName="w-16" id="common.preview" />}
    >
      <TemplateCataloguePreviewPending />
    </TemplateCataloguePreviewFrame>
  </TemplateCatalogueDetailFrame>
);
