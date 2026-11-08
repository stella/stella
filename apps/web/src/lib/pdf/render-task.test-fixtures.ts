import type { RenderTask } from "@/lib/pdf/pdfjs-loader";

type FakeRenderTaskOptions = {
  readonly promise: Promise<void>;
  readonly cancel?: () => void;
};

/**
 * A pdf.js render task drawn on the main thread that settles with `promise`.
 * Tests build every fake task here, so a member pdf.js adds to `RenderTask`
 * fails this one literal instead of each test's copy.
 */
export const fakeRenderTask = ({
  promise,
  cancel = () => undefined,
}: FakeRenderTaskOptions) =>
  ({
    _internalRenderTask: null,
    onContinue: () => undefined,
    onError: () => undefined,
    onFrame: () => undefined,
    promise,
    cancel,
    separateAnnots: false,
    imageCoordinates: {},
    isWorkerRendering: false,
  }) satisfies RenderTask;
