import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

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

test("reader scale uses the host supplied value on the first render", () => {
  expect(
    renderToStaticMarkup(<ScaleRoot options={{ initialScale: 1.4 }} />),
  ).toBe(
    '<article data-slot="reader-text-root" style="--reader-text-scale:1.4">1.4:false:true</article>',
  );
});

test("reader scale renders the default root when the host uses its default", () => {
  expect(renderToStaticMarkup(<ScaleRoot />)).toBe(
    '<article data-slot="reader-text-root" style="--reader-text-scale:1">1:false:false</article>',
  );
});
