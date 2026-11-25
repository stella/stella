import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Switch, SwitchField } from "./switch";

describe("Switch", () => {
  test("defaults to the setting size", () => {
    const markup = renderToStaticMarkup(<Switch aria-label="Sync" />);

    expect(markup).toContain('data-size="default"');
    expect(markup).toContain("h-5 w-9");
    expect(markup).toContain("size-4");
  });

  test("has a small size for dense rows", () => {
    const markup = renderToStaticMarkup(<Switch aria-label="Sync" size="sm" />);

    expect(markup).toContain('data-size="sm"');
    expect(markup).toContain("h-4 w-7");
    expect(markup).toContain("size-3");
    expect(markup).not.toContain("h-5 w-9");
  });

  test("draws on as the green track and off as the grey one, under a white thumb", () => {
    const on = renderToStaticMarkup(
      <Switch aria-label="Sync" defaultChecked />,
    );
    const off = renderToStaticMarkup(<Switch aria-label="Sync" />);

    for (const markup of [on, off]) {
      expect(markup).toContain("data-checked:bg-switch-track-checked");
      expect(markup).toContain("data-unchecked:bg-switch-track");
      expect(markup).toContain("bg-switch-thumb");
      // The primary fill is near white in the dark scheme, where it read
      // as off.
      expect(markup).not.toContain("bg-primary");
      expect(markup).not.toContain("bg-background");
    }
    expect(on).toContain('aria-checked="true"');
    expect(off).toContain('aria-checked="false"');
  });

  test("keeps the switch mounted when disabled with a disabledReason", () => {
    const markup = renderToStaticMarkup(
      <Switch
        aria-label="Require SSO"
        disabled
        disabledReason="Add an identity provider first"
      />,
    );

    expect(markup).toContain("data-disabled");
    expect(markup).toContain('role="switch"');
  });
});

describe("SwitchField", () => {
  test("makes the whole row the switch's label", () => {
    const markup = renderToStaticMarkup(
      <SwitchField
        defaultChecked
        description="Send a summary every morning"
        label="Daily digest"
      />,
    );

    expect(markup).toStartWith("<label");
    expect(markup).toContain('data-slot="switch-field"');
    expect(markup).toContain("min-h-11");
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("Daily digest");
    const describedBy = /aria-describedby="(?<id>[^"]+)"/u.exec(markup)
      ?.groups?.["id"];
    expect(describedBy).toBeDefined();
    expect(markup).toContain(`id="${String(describedBy)}"`);
  });

  test("adds no description link without a description", () => {
    const markup = renderToStaticMarkup(<SwitchField label="Daily digest" />);

    expect(markup).not.toContain("aria-describedby");
    expect(markup).not.toContain("switch-field-description");
  });
});
