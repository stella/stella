import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { MatterActivityRow } from "@/components/matter-activity-row";

const CLASS_NAME_PATTERN = /class="([^"]+)"/u;

const renderClassName = (element: React.ReactElement) => {
  const markup = renderToStaticMarkup(
    <MatterActivityRow>{element}</MatterActivityRow>,
  );
  return CLASS_NAME_PATTERN.exec(markup)?.at(1) ?? "";
};

describe("MatterActivityRow", () => {
  test("keeps links and buttons on the same visual row contract", () => {
    const linkClassName = renderClassName(
      <a href="/matter">
        <span aria-hidden />
      </a>,
    );
    const buttonClassName = renderClassName(<button type="button" />);

    expect(linkClassName).not.toBe("");
    expect(buttonClassName).toBe(linkClassName);
    expect(buttonClassName).toContain("text-xs");
    expect(buttonClassName).not.toContain("sm:text-sm");
    expect(buttonClassName).not.toContain("font-medium");
  });
});
