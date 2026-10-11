import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { PageViewport } from "@/lib/pdf/pdfjs-loader";

import type {
  CropPanelPage,
  PageOrganizerCropProps,
} from "./page-organizer-crop";
import type { NormalizedCrop } from "./page-organizer.logic";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { Dialog, DialogPopup } = await import("@stll/ui/dialog");
const { PageOrganizerCrop } = await import("./page-organizer-crop");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const en = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type ViewportOptions = {
  widthMm: number;
  heightMm: number;
  scale: number;
  rotation: number;
};

const makeViewport = ({
  widthMm,
  heightMm,
  scale,
  rotation,
}: ViewportOptions): PageViewport => {
  const widthPt = (widthMm * 72) / 25.4;
  const heightPt = (heightMm * 72) / 25.4;
  const rotated = rotation === 90 || rotation === 270;
  return {
    viewBox: [0, 0, widthPt, heightPt],
    userUnit: 1,
    scale,
    rotation,
    offsetX: 0,
    offsetY: 0,
    transform: [scale, 0, 0, -scale, 0, heightPt * scale],
    width: (rotated ? heightPt : widthPt) * scale,
    height: (rotated ? widthPt : heightPt) * scale,
    rawDims: { pageWidth: widthPt, pageHeight: heightPt, pageX: 0, pageY: 0 },
    clone: () => makeViewport({ widthMm, heightMm, scale, rotation }),
    convertToViewportPoint: (x, y) => [x * scale, y * scale],
    convertToPdfPoint: (x, y) => [x / scale, y / scale],
  };
};

type FakePageOptions = {
  id?: string;
  widthMm?: number;
  heightMm?: number;
  crop?: NormalizedCrop;
  rotation?: CropPanelPage["page"]["rotation"];
  renderPromise?: Promise<void>;
};

const makePage = ({
  id = "page-a",
  widthMm = 200,
  heightMm = 300,
  crop,
  rotation = 0,
  renderPromise = Promise.resolve(),
}: FakePageOptions = {}) => {
  const calls = { renders: 0, cancels: 0 };
  const page = {
    page: {
      id,
      sourceId: "fixture",
      sourcePageIndex: 0,
      rotation,
      ...(crop ? { crop } : {}),
    },
    pageInfo: {
      proxy: {
        getViewport: (options) =>
          makeViewport({
            widthMm,
            heightMm,
            scale: options?.scale ?? 1,
            rotation: options?.rotation ?? rotation,
          }),
        render: () => {
          calls.renders += 1;
          return {
            _internalRenderTask: null,
            onContinue: () => undefined,
            onError: () => undefined,
            promise: renderPromise,
            cancel: () => {
              calls.cancels += 1;
            },
            separateAnnots: false,
            imageCoordinates: {},
          };
        },
      },
    },
  } satisfies CropPanelPage;
  return { page, calls };
};

const required = (selector: string) =>
  screen.getByRole("dialog").querySelector<HTMLElement>(selector) ??
  panic(`Missing crop control: ${selector}`);
const field = (side: "top" | "right" | "bottom" | "left") =>
  screen
    .getByRole("dialog")
    .querySelector<HTMLInputElement>(`input[id$="-${side}"]`) ??
  panic(`Missing crop margin: ${side}`);

const mount = (pages: readonly CropPanelPage[]) => {
  const applied: ReadonlyMap<string, NormalizedCrop | null>[] = [];
  const errors: unknown[] = [];
  let resets = 0;
  const callbacks = {
    onApply: (crops) => {
      applied.push(crops);
    },
    onReset: () => {
      resets += 1;
    },
    disabled: false,
  } satisfies Omit<PageOrganizerCropProps, "pages">;
  const view = render(
    <IntlProvider locale="en" messages={en}>
      <AnalyticsContext
        value={{
          ...noopAnalytics,
          captureError: (error) => {
            errors.push(error);
          },
        }}
      >
        <Dialog open>
          <DialogPopup>
            <PageOrganizerCrop pages={pages} {...callbacks} />
          </DialogPopup>
        </Dialog>
      </AnalyticsContext>
    </IntlProvider>,
  );
  return { applied, errors, resets: () => resets, view };
};

const ready = async () =>
  waitFor(() =>
    expect(required('[data-crop-handle="w"]').hasAttribute("disabled")).toBe(
      false,
    ),
  );

const expectCrop = (
  actual: NormalizedCrop | null | undefined,
  expected: NormalizedCrop,
) => {
  expect(actual).toBeDefined();
  if (!actual) {
    panic("Expected a normalized crop");
  }
  expect(actual).toEqual({
    x: expect.closeTo(expected.x, 8),
    y: expect.closeTo(expected.y, 8),
    width: expect.closeTo(expected.width, 8),
    height: expect.closeTo(expected.height, 8),
  } satisfies Record<keyof NormalizedCrop, unknown>);
};

test("prefills physical margins and binds a handle drag and numeric fields in both directions", async () => {
  mount([
    makePage({ crop: { x: 0.05, y: 0.1, width: 0.9, height: 0.8 } }).page,
  ]);
  await ready();
  expect(field("left").value).toBe("10");
  expect(field("right").value).toBe("10");
  expect(field("top").value).toBe("30");
  expect(field("bottom").value).toBe("30");
  const handle = required('[data-crop-handle="w"]');
  const surface =
    required("canvas").parentElement ?? panic("Crop canvas needs a surface");
  Object.assign(surface, {
    getBoundingClientRect: () => new DOMRect(0, 0, 200, 300),
  });
  Object.assign(handle, { setPointerCapture: () => undefined });
  fireEvent.pointerDown(handle, {
    button: 0,
    clientX: 10,
    clientY: 30,
    pointerId: 1,
  });
  fireEvent.pointerMove(handle, { clientX: 30, clientY: 30, pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(field("left").value).toBe("30");
  expect(field("right").value).toBe("10");
  fireEvent.change(field("left"), { target: { value: "40" } });
  expect(field("left").value).toBe("40");
  expect(Number.parseFloat(required("[data-crop-box]").style.left)).toBeCloseTo(
    20,
  );
  expect(
    Number.parseFloat(required("[data-crop-box]").style.width),
  ).toBeCloseTo(75);
});

test("arrow keys nudge a focused handle by 1 mm or 10 mm with Shift", async () => {
  mount([makePage({}).page]);
  await ready();
  const handle = required('[data-crop-handle="w"]');
  handle.focus();
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(field("left").value).toBe("1");
  fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
  expect(field("left").value).toBe("11");
  fireEvent.keyDown(handle, { key: "Escape" });
  expect(field("left").value).toBe("11");
  expect(document.activeElement).toBe(handle);
});

test("stepping across mixed page sizes preserves millimetres and applies page-specific normalized crops", async () => {
  const first = makePage({ widthMm: 200, heightMm: 300 });
  const second = makePage({ id: "page-b", widthMm: 100, heightMm: 150 });
  const { applied } = mount([first.page, second.page]);
  await ready();
  fireEvent.change(field("left"), { target: { value: "10" } });
  fireEvent.change(field("top"), { target: { value: "15" } });
  fireEvent.click(required('[data-crop-action="next"]'));
  await ready();
  expect(field("left").value).toBe("10");
  expect(field("top").value).toBe("15");
  expect(Number.parseFloat(required("[data-crop-box]").style.left)).toBeCloseTo(
    10,
  );
  fireEvent.click(required('[data-crop-action="apply"]'));
  expect(applied).toHaveLength(1);
  expectCrop(applied.at(0)?.get("page-a"), {
    x: 0.05,
    y: 0,
    width: 0.95,
    height: 0.95,
  });
  expectCrop(applied.at(0)?.get("page-b"), {
    x: 0.1,
    y: 0,
    width: 0.9,
    height: 0.9,
  });
  expect(first.calls.cancels).toBe(1);
  expect(second.calls.renders).toBe(1);
});

test("reset invokes the organizer crop reset and unmount cancels the preview render", async () => {
  const { page, calls } = makePage({
    crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  });
  const { resets, view } = mount([page]);
  await ready();
  fireEvent.click(required('[data-crop-action="reset"]'));
  expect(resets()).toBe(1);
  view.unmount();
  expect(calls.cancels).toBe(1);
});

test("a rejected preview render surfaces an alert and reports its error", async () => {
  const rendering = Promise.withResolvers<undefined>();
  const { page } = makePage({ renderPromise: rendering.promise });
  const { errors } = mount([page]);
  const failure = new Error("fixture render failure");
  await act(async () => {
    rendering.reject(failure);
  });
  expect((await screen.findByRole("alert")).textContent).toBe(
    en.workspaces.pdf.pageEditor.cropPreviewFailed,
  );
  expect(errors).toEqual([expect.objectContaining({ cause: failure })]);
  expect(
    screen.getByRole("dialog").querySelector("[data-crop-box]"),
  ).toBeNull();
});

test("unmount cancels an unfinished render and ignores its subsequent rejection", async () => {
  const rendering = Promise.withResolvers<undefined>();
  const { page, calls } = makePage({ renderPromise: rendering.promise });
  const { errors, view } = mount([page]);
  expect(calls.renders).toBe(1);
  view.unmount();
  expect(calls.cancels).toBe(1);
  await act(async () => {
    rendering.reject(new Error("fixture cancelled render"));
  });
  expect(errors).toEqual([]);
});
