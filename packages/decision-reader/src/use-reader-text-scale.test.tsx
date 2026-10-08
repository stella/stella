import { renderToStaticMarkup } from "react-dom/server";

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
