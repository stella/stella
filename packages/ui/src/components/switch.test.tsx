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
    expect(markup).toContain(`id="${describedBy}"`);
  });

  test("adds no description link without a description", () => {
    const markup = renderToStaticMarkup(<SwitchField label="Daily digest" />);

    expect(markup).not.toContain("aria-describedby");
    expect(markup).not.toContain("switch-field-description");
  });
});
