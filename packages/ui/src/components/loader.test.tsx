import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { Loader, LoaderState } from "./loader";

test("standalone loading announces its translated label", () => {
  const markup = renderToStaticMarkup(<Loader label="Načítání" size="sm" />);
  expect(markup).toContain('role="status"');
  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain('aria-label="Načítání"');
});

test("inline loading leaves announcements to the enclosing control", () => {
  const markup = renderToStaticMarkup(
    <Loader size="sm" variant="decorative" />,
  );
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).not.toContain('role="status"');
  expect(markup).not.toContain("aria-label");
});

test("a busy control or row shows a plain spinner, not the mark", () => {
  const markup = renderToStaticMarkup(
    <Loader size="sm" variant="decorative" />,
  );
  expect(markup).toContain("animate-spin");
  expect(markup).not.toContain("animate-loader");
});

test("an empty region keeps the breathing mark", () => {
  const markup = renderToStaticMarkup(<LoaderState label="Processing" />);
  expect(markup).toContain("animate-loader");
  expect(markup).not.toContain("animate-spin");
});
