import { useState } from "react";

import { PDF } from "@libpdf/core";
import { Result } from "better-result";

import { MeasuredPdfProvider } from "@/components/inspector/measured-pdf-provider";
import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";
import {
  PeekPdfControls,
  PeekPdfViewport,
} from "@/components/pdf/peek/peek-pdf-viewer";
import { useMountEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";

/** A4 landscape, in points. */
const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const PAGE_COUNT = 2;

/** The panes the fixture is drawn in: an inspector at its default and a wide one. */
const PANES = [
  { name: "inspector", width: 512 },
  { name: "wide", width: 960 },
] as const;

type PaneName = (typeof PANES)[number]["name"];

const NOOP = () => undefined;

const landscapePdf = async (): Promise<ArrayBuffer> => {
  const pdf = PDF.create();
  for (let index = 0; index < PAGE_COUNT; index += 1) {
    const page = pdf.addPage({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
    // Ink up to the corners, where a clipped edge or a floating control
    // would hide it.
    page.drawText(`Landscape page ${index + 1}`, {
      x: 24,
      y: PAGE_HEIGHT - 36,
      size: 14,
    });
    page.drawText("Top right", { x: PAGE_WIDTH - 96, y: PAGE_HEIGHT - 36 });
    page.drawText("Bottom right", { x: PAGE_WIDTH - 112, y: 24 });
  }
  return new Uint8Array(await pdf.save()).buffer;
};

type FixtureState =
  | { status: "loading" }
  | { status: "ready"; bytes: Record<PaneName, ArrayBuffer> }
  | { status: "failed"; message: string };

/**
 * Landscape pages fitted to a preview pane's width, with the zoom controls
 * floating over the pane's top corner as the inspector draws them. Measured by
 * `pdf-fit-width.geometry.spec.ts`.
 */
export const PdfFitWidthPlayground = () => {
  const analytics = useAnalytics();
  const [fixture, setFixture] = useState<FixtureState>({ status: "loading" });

  useMountEffect(() => {
    const lifecycle = { disposed: false };
    detached(
      (async () => {
        const result = await Result.tryPromise(landscapePdf);
        if (lifecycle.disposed) {
          return;
        }
        if (Result.isError(result)) {
          analytics.captureError(result.error, {
            fingerprintKey: "PdfFitWidthPlayground:failure",
            scope: {
              type: "handler",
              handlerId: "PdfFitWidthPlayground:failure",
            },
          });
          setFixture({ status: "failed", message: result.error.message });
          return;
        }
        // Each pane parses its own copy: a loaded buffer goes to the PDF
        // worker.
        setFixture({
          status: "ready",
          bytes: {
            inspector: result.value.slice(0),
            wide: result.value,
          },
        });
      })(),
      "pdf-fit-width-fixture.load",
    );
    return () => {
      lifecycle.disposed = true;
    };
  });

  if (fixture.status === "loading") {
    return <p>Loading PDF fixture…</p>;
  }
  if (fixture.status === "failed") {
    return <p role="alert">{fixture.message}</p>;
  }

  return (
    <div className="flex flex-wrap items-start gap-6 p-4">
      {PANES.map((pane) => (
        <section
          className="relative flex h-[420px] min-w-0 overflow-hidden border"
          data-pdf-fit-pane={pane.name}
          key={pane.name}
          style={{ width: pane.width }}
        >
          {/* The inspector's wrapper: the viewer takes the pane's width. */}
          <div className="min-h-0 min-w-0 flex-1">
            <MeasuredPdfProvider
              active
              fieldId={`pdf-fit-width-${pane.name}`}
              initialScaleOffset={0}
              surface="inspector-pdf"
            >
              <PeekPdfViewport
                buffer={fixture.bytes[pane.name]}
                colorMode="light"
                fileId={`pdf-fit-width-${pane.name}`}
                pageSource="portfolio"
                scaleOffset={0}
                underOverlayBar
              />
            </MeasuredPdfProvider>
          </div>
          <ViewerOverlayBar>
            <PeekPdfControls onReset={NOOP} onZoom={NOOP} scaleOffset={0} />
          </ViewerOverlayBar>
        </section>
      ))}
    </div>
  );
};
