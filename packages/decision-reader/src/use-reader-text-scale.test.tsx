import { renderToStaticMarkup } from "react-dom/server";

import { panic } from "better-result";
import { expect, test } from "bun:test";

import { READER_TEXT_SCALE_STORAGE_KEY } from "./reader-text-scale.logic";
import { useReaderTextScale } from "./use-reader-text-scale";
import type { ReaderTextScaleOptions } from "./use-reader-text-scale";

const ScaleRoot = ({ options }: { options?: ReaderTextScaleOptions }) => {
  const scale = useReaderTextScale(options);
  return (
    <article {...scale.rootProps}>
      {String(scale.level)}:{String(scale.atMin)}:{String(scale.atMax)}
    </article>
  );
};

test("reader scale renders its default root without browser storage", () => {
  expect(renderToStaticMarkup(<ScaleRoot />)).toBe(
    '<article data-slot="reader-text-root" style="--reader-text-scale:1">1:false:false</article>',
  );
});

test("reader scale reads an injected storage once and preserves its bounds", () => {
  const readKeys: string[] = [];
  const options = {
    storage: {
      getItem: (key: string) => {
        readKeys.push(key);
        return "1.4";
      },
      setItem: () => undefined,
    },
  } satisfies ReaderTextScaleOptions;
  expect(renderToStaticMarkup(<ScaleRoot options={options} />)).toBe(
    '<article data-slot="reader-text-root" style="--reader-text-scale:1.4">1.4:false:true</article>',
  );
  expect(readKeys).toEqual([READER_TEXT_SCALE_STORAGE_KEY]);
});

test("reader scale keeps its default when injected storage cannot be read", () => {
  const options = {
    storage: {
      getItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
      setItem: () => undefined,
    },
  } satisfies ReaderTextScaleOptions;
  expect(renderToStaticMarkup(<ScaleRoot options={options} />)).toBe(
    '<article data-slot="reader-text-root" style="--reader-text-scale:1">1:false:false</article>',
  );
});

test("reader scale keeps its default for malformed or unsupported stored sizes", () => {
  for (const raw of [null, "{", "1.15", '"1.4"']) {
    const options = {
      storage: {
        getItem: () => raw,
        setItem: () => undefined,
      },
    } satisfies ReaderTextScaleOptions;
    expect(renderToStaticMarkup(<ScaleRoot options={options} />)).toBe(
      '<article data-slot="reader-text-root" style="--reader-text-scale:1">1:false:false</article>',
    );
  }
});

test("a refused storage write keeps the selected scale visible and reports one failure", async () => {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  const previousActEnvironment = Reflect.get(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const cause = new DOMException("Storage full", "QuotaExceededError");
  const failures: unknown[] = [];
  const writes: { key: string; value: string }[] = [];
  const options = {
    storage: {
      getItem: () => "1",
      setItem: (key: string, value: string) => {
        writes.push({ key, value });
        throw cause;
      },
    },
    analytics: { captureError: (error: unknown) => failures.push(error) },
  } satisfies ReaderTextScaleOptions;
  const ScaleControls = () => {
    const scale = useReaderTextScale(options);
    return (
      <article {...scale.rootProps}>
        <output>{scale.level}</output>
        <button type="button" onClick={() => scale.zoom("in")}>
          Larger
        </button>
      </article>
    );
  };
  try {
    await act(() => root.render(<ScaleControls />));
    const article =
      container.querySelector("article") ?? panic("Missing scale root");
    const button =
      container.querySelector("button") ?? panic("Missing scale control");
    expect(article.style.getPropertyValue("--reader-text-scale")).toBe("1");
    expect(failures).toEqual([]);

    await act(() => button.click());
    expect(article.style.getPropertyValue("--reader-text-scale")).toBe("1.1");
    expect(article.querySelector("output")?.textContent).toBe("1.1");
    expect(writes).toEqual([
      { key: READER_TEXT_SCALE_STORAGE_KEY, value: "1.1" },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures.at(0)).toMatchObject({
      action: "write-reader-text-scale",
      cause,
    });

    await act(() => root.render(<ScaleControls />));
    expect(article.style.getPropertyValue("--reader-text-scale")).toBe("1.1");
    expect(failures).toHaveLength(1);
  } finally {
    await act(() => root.unmount());
    container.remove();
    if (previousActEnvironment === undefined) {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    } else {
      Reflect.set(
        globalThis,
        "IS_REACT_ACT_ENVIRONMENT",
        previousActEnvironment,
      );
    }
    await GlobalRegistrator.unregister();
  }
});
