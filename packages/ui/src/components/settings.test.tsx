import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  SettingsPanel,
  SettingsRow,
  settingsRowIds,
  SettingsSection,
} from "./settings";
import { Switch } from "./switch";

const idsIn = (markup: string) =>
  new Set(
    Array.from(markup.matchAll(/ id="(?<id>[^"]+)"/gu), (match) =>
      String(match.groups?.["id"]),
    ),
  );

describe("SettingsSection", () => {
  test("is named by its title", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection description="One quiet line" title="Chat">
        <SettingsPanel>Form</SettingsPanel>
      </SettingsSection>,
    );

    const labelledBy = /aria-labelledby="([^"]+)"/u.exec(markup)?.[1];
    expect(labelledBy).toBeDefined();
    expect(idsIn(markup)).toContain(String(labelledBy));
    expect(markup).toContain("One quiet line");
  });

  test("draws no header for empty or false slots", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection action={false}>
        <SettingsPanel>Form</SettingsPanel>
      </SettingsSection>,
    );

    expect(markup).not.toContain("list-group-header");
    expect(markup).not.toContain("aria-labelledby");
  });
});

describe("SettingsRow", () => {
  test("a label row names its switch by the row's title and line", () => {
    const ids = settingsRowIds("digest");
    const markup = renderToStaticMarkup(
      <SettingsRow
        description="Send a summary every morning"
        id="digest"
        interaction="label"
        title="Daily digest"
      >
        <Switch
          aria-describedby={ids.description}
          aria-labelledby={ids.label}
          id={ids.control}
        />
      </SettingsRow>,
    );

    expect(markup).toContain(`<label`);
    expect(markup).toContain(`for="${ids.control}"`);
    expect(markup).toContain('role="switch"');
    expect(idsIn(markup)).toContain(ids.control);
    expect(idsIn(markup)).toContain(ids.label);
    expect(idsIn(markup)).toContain(ids.description);
  });

  test("a plain row is not a label and draws no empty control slot", () => {
    const markup = renderToStaticMarkup(
      <SettingsRow description="my.stll.app" title="Server" />,
    );

    expect(markup).not.toContain("<label");
    expect(markup).not.toContain("settings-row-control");
  });

  test("a row with media starts its footer on its title's edge, past the tile", () => {
    const footerOf = (markup: string) =>
      /<\/div><div class="(?<footer>[^"]+)"><span>Version 2/u.exec(markup)
        ?.groups?.["footer"];
    const tile = <span className="size-8" data-slot="list-item-media" />;
    const withMedia = renderToStaticMarkup(
      <SettingsRow
        footer={<span>Version 2</span>}
        media={tile}
        title="Codex"
      />,
    );
    const nested = renderToStaticMarkup(
      <SettingsRow
        depth="nested"
        footer={<span>Version 2</span>}
        media={tile}
        title="Codex"
      />,
    );
    const plain = renderToStaticMarkup(
      <SettingsRow footer={<span>Version 2</span>} title="Codex" />,
    );

    // The row's own inset (ps-4, ps-10) plus the 32px tile and 12px gap.
    expect(footerOf(withMedia)).toContain("ps-15");
    expect(footerOf(nested)).toContain("ps-21");
    expect(footerOf(plain)).toContain("ps-4");
    expect(footerOf(plain)).not.toContain("ps-15");
  });

  test("a row a settings link names can take focus and be marked", () => {
    const targeted = renderToStaticMarkup(
      <SettingsRow target="agents-codex" title="Codex" />,
    );
    const plain = renderToStaticMarkup(<SettingsRow title="Codex" />);

    expect(targeted).toContain('data-settings-target="agents-codex"');
    expect(targeted).toContain('tabindex="-1"');
    expect(targeted).toContain("data-highlighted:bg-muted");
    expect(plain).not.toContain("data-settings-target");
    expect(plain).not.toContain("tabindex");
  });
});
