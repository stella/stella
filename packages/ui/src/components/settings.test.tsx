import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  SettingsPanel,
  SettingsRow,
  settingsRowIds,
  SettingsSection,
} from "./settings";
import { Switch } from "./switch";

const idsIn = (markup: string): Set<string> =>
  new Set(Array.from(markup.matchAll(/ id="([^"]+)"/gu), (match) => match[1]));

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
        />
      </SettingsRow>,
    );

    expect(markup).toContain("<label");
    expect(markup).toContain('role="switch"');
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
});
