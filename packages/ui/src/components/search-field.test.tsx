import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { SearchField } from "./search-field";

const clearButton = (markup: string) =>
  /<button[^>]*aria-label="Clear search"[^>]*>/u.exec(markup)?.[0] ?? "";

// Natively disabled, or `aria-disabled` when the button keeps its tooltip.
const isUnavailable = (button: string) =>
  / disabled=""/u.test(button) || button.includes('aria-disabled="true"');

describe("SearchField clear button", () => {
  test("clears an editable field", () => {
    const markup = renderToStaticMarkup(
      <SearchField
        clearLabel="Clear search"
        onValueChange={() => {}}
        value="lease"
      />,
    );
    expect(clearButton(markup)).not.toBe("");
    expect(isUnavailable(clearButton(markup))).toBe(false);
  });

  test("is unavailable while the field is disabled", () => {
    const markup = renderToStaticMarkup(
      <SearchField
        clearLabel="Clear search"
        disabled
        onValueChange={() => {}}
        value="lease"
      />,
    );
    expect(isUnavailable(clearButton(markup))).toBe(true);
  });
});
