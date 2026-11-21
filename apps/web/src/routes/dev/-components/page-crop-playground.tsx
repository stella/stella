import { useState } from "react";

import { PDF, PdfArray, PdfName, PdfNumber } from "@libpdf/core";
import { Result } from "better-result";

import { Button } from "@stll/ui/button";
import { Dialog, DialogPopup } from "@stll/ui/dialog";

import { PageOrganizerCrop } from "@/components/pdf/page-organizer-crop";
import type { CropPanelPage } from "@/components/pdf/page-organizer-crop";
import { marginsMmToCrop } from "@/components/pdf/page-organizer-crop.logic";
import type { NormalizedCrop } from "@/components/pdf/page-organizer.logic";
import { useMountEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { destroyPDFDocument } from "@/lib/pdf/pdf-cleanup";
import { loadPDF } from "@/lib/pdf/pdf-loader";
import type { PDFDocument } from "@/lib/pdf/pdf-loader";

const POINTS_PER_MM = 72 / 25.4;
const PREFILL = { top: 10, right: 15, bottom: 20, left: 25 };

type FixtureState =
  | { status: "loading" }
  | { status: "ready"; pages: CropPanelPage[] }
  | { status: "failed"; message: string };

export const PageCropPlayground = () => {
  const analytics = useAnalytics();
  const [fixture, setFixture] = useState<FixtureState>({ status: "loading" });
  const [open, setOpen] = useState(true);
  const [output, setOutput] = useState("");

  useMountEffect(() => {
    const lifecycle = { disposed: false };
    let document: PDFDocument | undefined;
    detached(
      (async () => {
        const result = await Result.tryPromise(async () => {
          const pdf = PDF.create();
          for (const [index, scale] of [1, 0.5].entries()) {
            const width = 210 * scale * POINTS_PER_MM;
            const height = 297 * scale * POINTS_PER_MM;
            const page = pdf.addPage({
              width: width + 40,
              height: height + 40,
            });
            // The visible source starts away from the MediaBox origin, while
            // its physical dimensions remain exactly A4 and half-sized A4.
            page.dict.set(
              PdfName.of("CropBox"),
              PdfArray.of(
                ...[20, 20, 20 + width, 20 + height].map((value) =>
                  PdfNumber.of(value),
                ),
              ),
            );
            page.setRotation(index === 0 ? 0 : 90);
            page.drawText(`Crop fixture ${index + 1}`, {
              x: 45,
              y: height - 35,
              size: 14,
            });
            page.drawText("Visible source content", {
              x: 45,
              y: height / 2,
              size: 12,
            });
          }
          const bytes = await pdf.save();
          const loaded = (
            await loadPDF({
              fileId: "page-crop-fixture",
              pageSource: "portfolio",
              buffer: new Uint8Array(bytes).buffer,
            })
          ).unwrap("The generated crop fixture PDF must load");
          document = loaded;
          if (lifecycle.disposed) {
            await destroyPDFDocument(loaded);
            return undefined;
          }
          const pages = [...loaded.pages.values()].map((pageInfo, index) => {
            const viewport = pageInfo.proxy.getViewport({
              scale: 1,
              rotation: 0,
            });
            const rotation = index === 0 ? 0 : 90;
            return {
              pageInfo,
              page: {
                id: `crop-fixture-${index}`,
                sourceId: "page-crop-fixture",
                sourcePageIndex: index,
                rotation,
                crop: marginsMmToCrop(PREFILL, {
                  width: viewport.width,
                  height: viewport.height,
                  rotation,
                }),
              },
            } satisfies CropPanelPage;
          });
          setFixture({ status: "ready", pages });
          return undefined;
        });
        if (Result.isError(result)) {
          analytics.captureError(result.error, {
            fingerprintKey: "PageCropPlayground:failure",
            scope: { type: "handler", handlerId: "PageCropPlayground:failure" },
          });
          if (!lifecycle.disposed) {
            setFixture({ status: "failed", message: result.error.message });
          }
        }
      })(),
      "page-crop-fixture.load",
    );
    return () => {
      lifecycle.disposed = true;
      if (document) {
        detached(destroyPDFDocument(document), "page-crop-fixture.destroy");
      }
    };
  });

  if (fixture.status === "loading") {
    return <p>Loading PDF fixture…</p>;
  }
  if (fixture.status === "failed") {
    return <p role="alert">{fixture.message}</p>;
  }

  const apply = (crops: ReadonlyMap<string, NormalizedCrop | null>) => {
    const pages = fixture.pages.map(({ page, pageInfo }) => {
      const crop = crops.get(page.id);
      const viewport = pageInfo.proxy.getViewport({
        scale: 1,
        rotation: page.rotation,
      });
      return {
        id: page.id,
        widthMm: viewport.width / POINTS_PER_MM,
        heightMm: viewport.height / POINTS_PER_MM,
        crop,
      };
    });
    setOutput(JSON.stringify(pages));
    setFixture({
      status: "ready",
      pages: fixture.pages.map(({ page, pageInfo }) => {
        const crop = crops.get(page.id);
        return {
          pageInfo,
          page: {
            id: page.id,
            sourceId: page.sourceId,
            sourcePageIndex: page.sourcePageIndex,
            rotation: page.rotation,
            ...(crop && { crop }),
          },
        };
      }),
    });
    setOpen(false);
  };

  return (
    <div className="space-y-4 p-4" data-page-crop-fixture="">
      <Button data-crop-reopen="" onClick={() => setOpen(true)}>
        Reopen crop
      </Button>
      <output className="block break-all" data-crop-output="">
        {output}
      </output>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-3xl">
          {open && (
            <PageOrganizerCrop
              pages={fixture.pages}
              disabled={false}
              onApply={apply}
              onReset={() =>
                apply(new Map(fixture.pages.map(({ page }) => [page.id, null])))
              }
            />
          )}
        </DialogPopup>
      </Dialog>
    </div>
  );
};
