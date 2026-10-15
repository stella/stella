import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { Loader } from "./loader";

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
