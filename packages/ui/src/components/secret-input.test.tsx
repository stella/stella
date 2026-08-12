import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { SecretInput } from "./secret-input";

describe("SecretInput", () => {
  test("conceals the value and renders its visibility toggle by default", () => {
    const markup = renderToStaticMarkup(
      <SecretInput
        hideValueLabel="Hide secret value"
        showValueLabel="Show secret value"
        value="secret"
      />,
    );

    expect(markup).toContain('type="password"');
    expect(markup).toContain('aria-label="Show secret value"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('data-slot="secret-input-visibility-toggle"');
  });

  test("disables the visibility toggle with the field", () => {
    const markup = renderToStaticMarkup(
      <SecretInput
        disabled
        hideValueLabel="Hide secret value"
        showValueLabel="Show secret value"
      />,
    );

    // The toggle names itself with `aria-label`, which `Button` also renders as
    // a tooltip, so disabling it takes the accessible-disabled path: reachable
    // for hover and focus, with every activation blocked.
    expect(markup).toContain(
      'data-slot="secret-input-visibility-toggle" aria-disabled="true"',
    );
    expect(markup).not.toContain(
      'data-slot="secret-input-visibility-toggle" disabled=""',
    );
  });
});
