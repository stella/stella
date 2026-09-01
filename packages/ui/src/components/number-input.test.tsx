import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { NumberInput } from "./number-input";

describe("NumberInput", () => {
  test("keeps structured editing LTR and coarse-pointer targets by default", () => {
    const markup = renderToStaticMarkup(<NumberInput />);

    expect(markup).toContain('dir="ltr"');
    expect(markup).toContain("pointer-coarse:min-h-11");
    expect(markup).toContain("pointer-coarse:h-full");
  });

  test("allows an explicit direction override", () => {
    const markup = renderToStaticMarkup(<NumberInput dir="rtl" />);

    expect(markup).toContain('dir="rtl"');
  });
});
