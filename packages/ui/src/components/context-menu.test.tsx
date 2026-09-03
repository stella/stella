import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { ContextMenu } from "./context-menu";

describe("ContextMenu", () => {
  test("renders only its children when there are no actions", () => {
    const markup = renderToStaticMarkup(
      <ContextMenu actions={[]}>
        <span data-testid="content">content</span>
      </ContextMenu>,
    );

    expect(markup).toBe('<span data-testid="content">content</span>');
  });

  test("wraps the children in a right-click trigger when there are actions", () => {
    const markup = renderToStaticMarkup(
      <ContextMenu actions={[{ label: "Rename", onClick: () => undefined }]}>
        <span data-testid="content">content</span>
      </ContextMenu>,
    );

    expect(markup).toContain('data-slot="context-menu-trigger"');
    expect(markup).toContain('data-testid="content"');
  });
});
