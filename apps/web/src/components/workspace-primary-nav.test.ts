import { describe, expect, test } from "bun:test";

import { getWorkspacePrimaryNavItems } from "@/components/workspace-primary-nav";

const ALL_GATES_OPEN = {
  includeInbox: true,
  includePublicLaw: true,
};

const navIds = (overrides: Partial<typeof ALL_GATES_OPEN>) =>
  getWorkspacePrimaryNavItems({ ...ALL_GATES_OPEN, ...overrides }).map(
    (item) => item.id,
  );

const publicNavIds = getWorkspacePrimaryNavItems(ALL_GATES_OPEN)
  .filter((item) => item.audience === "public")
  .map((item) => item.id);

describe("workspace primary nav", () => {
  test("keeps guest access beside the canonical destination", () => {
    expect(publicNavIds).toEqual(["caseLaw"]);
  });

  test("keeps every entry while both gates are open", () => {
    expect(navIds({})).toEqual([
      "search",
      "chat",
      "inbox",
      "matters",
      "caseLaw",
      "knowledge",
      "contacts",
    ]);
  });

  // Each gate must remove its own entry and nothing else, so a closed inbox
  // gate cannot take the case-law entry down with it.
  test("drops only the entry whose gate closed", () => {
    expect(navIds({ includeInbox: false })).not.toContain("inbox");
    expect(navIds({ includeInbox: false })).toContain("caseLaw");
    expect(navIds({ includePublicLaw: false })).not.toContain("caseLaw");
    expect(navIds({ includePublicLaw: false })).toContain("inbox");
  });

  test("leaves the ungated entries alone when every gate closes", () => {
    expect(
      navIds({
        includeInbox: false,
        includePublicLaw: false,
      }),
    ).toEqual(["search", "chat", "matters", "knowledge", "contacts"]);
  });
});
