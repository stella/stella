import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Form } from "./form";

describe("Form", () => {
  test("stacks its fields with the default gap", () => {
    const markup = renderToStaticMarkup(<Form aria-label="Profile" />);

    expect(markup).toMatch(/^<form /u);
    expect(markup).toContain('aria-label="Profile"');
    expect(markup).toContain("flex-col");
    expect(markup).toContain("gap-4");
  });

  test("an inline compact form lays a field and its action on one line", () => {
    const markup = renderToStaticMarkup(
      <Form density="compact" layout="inline" />,
    );

    expect(markup).toContain("flex-row");
    expect(markup).toContain("gap-2");
    expect(markup).not.toContain("flex-col");
    expect(markup).not.toContain("gap-4");
  });
});
