import { describe, expect, test } from "bun:test";

import {
  BROWSER_SITE_NOTE_SITES_MAX,
  BROWSER_SITE_NOTES_PER_SITE_MAX,
  READ_SITE_NOTES_TOOL_NAME,
  SAVE_SITE_NOTES_TOOL_NAME,
} from "@stll/api-contract/browser-site-notes";

import {
  browserSiteNotesPromptSection,
  READ_SITE_NOTES_DESCRIPTION,
  SAVE_SITE_NOTES_DESCRIPTION,
} from "./agent-surface";

describe("research website notes in the agent's instructions", () => {
  test("names nothing when the member keeps no notes", () => {
    expect(browserSiteNotesPromptSection([])).toBe("");
  });

  test("names each noted website and tells the agent to read before its first step there", () => {
    const section = browserSiteNotesPromptSection([
      "https://alpha.example.com",
      "https://beta.example.com:8443",
    ]);
    expect(section).toContain("alpha.example.com, beta.example.com:8443");
    expect(section).toContain(
      `Before your first browser step on one of them, call ${READ_SITE_NOTES_TOOL_NAME}`,
    );
    expect(section).toContain(SAVE_SITE_NOTES_TOOL_NAME);
  });

  test("the tool descriptions state the enforced caps and the read-first rule", () => {
    expect(SAVE_SITE_NOTES_DESCRIPTION).toContain(
      `At most ${String(BROWSER_SITE_NOTES_PER_SITE_MAX)} notes per website and ${String(BROWSER_SITE_NOTE_SITES_MAX)} websites`,
    );
    expect(SAVE_SITE_NOTES_DESCRIPTION).toContain("nothing expires by age");
    expect(READ_SITE_NOTES_DESCRIPTION).toContain(
      "before your first browser step there",
    );
    expect(READ_SITE_NOTES_DESCRIPTION).toContain("never approval for a step");
  });
});
