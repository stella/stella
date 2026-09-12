import { lazy } from "react";
import { renderToReadableStream } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { BrowserOnly } from "./browser-only";

describe("BrowserOnly", () => {
  test("renders the fallback on the server without evaluating lazy children", async () => {
    const fallbackText = "loading";
    const childText = "lazy-child";
    let evaluated = false;
    const LazyChild = lazy(async () => {
      evaluated = true;
      return { default: () => <strong>{childText}</strong> };
    });
    const errors: unknown[] = [];
    const stream = await renderToReadableStream(
      <BrowserOnly fallback={<span>{fallbackText}</span>}>
        <LazyChild />
      </BrowserOnly>,
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );

    const html = await new Response(stream).text();

    expect(html).toContain(fallbackText);
    expect(html).not.toContain(childText);
    expect(evaluated).toBe(false);
    expect(errors).toEqual([]);
  });
});
