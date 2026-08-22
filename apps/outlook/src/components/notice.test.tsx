import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { Notice } from "@/components/notice";

test("announces async outcomes with the caller-selected urgency", () => {
  expect(
    renderToStaticMarkup(
      <Notice role="status" title="Saved" tone="success">
        The email was saved.
      </Notice>,
    ),
  ).toContain('role="status"');
  expect(
    renderToStaticMarkup(
      <Notice role="alert" title="Save failed" tone="risk">
        Try again.
      </Notice>,
    ),
  ).toContain('role="alert"');
});
