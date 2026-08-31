import { describe, expect, test } from "bun:test";

import { getWorkspacePrimaryNavItems } from "@/components/workspace-primary-nav";

const ALL_GATES_OPEN = {
  includeInbox: true,
  includePublicLaw: true,
  includePublicTools: true,
};

const navIds = (overrides: Partial<typeof ALL_GATES_OPEN>) =>
  getWorkspacePrimaryNavItems({ ...ALL_GATES_OPEN, ...overrides }).map(
    (item) => item.id,
  );

describe("workspace primary nav", () => {
  test("keeps every entry while all three gates are open", () => {
    expect(navIds({})).toEqual([
      "search",
      "chat",
      "inbox",
      "matters",
      "caseLaw",
      "tools",
      "knowledge",
      "contacts",
    ]);
  });

  // Each gate must remove its own entry and nothing else, so a closed inbox
  // gate cannot take the case-law or tools entry down with it.
  test("drops only the entry whose gate closed", () => {
    expect(navIds({ includeInbox: false })).not.toContain("inbox");
    expect(navIds({ includeInbox: false })).toContain("caseLaw");
    expect(navIds({ includeInbox: false })).toContain("tools");
    expect(navIds({ includePublicLaw: false })).toContain("inbox");
    expect(navIds({ includePublicTools: false })).toContain("inbox");
  });

  test("leaves the ungated entries alone when every gate closes", () => {
    expect(
      navIds({
        includeInbox: false,
        includePublicLaw: false,
        includePublicTools: false,
      }),
    ).toEqual(["search", "chat", "matters", "knowledge", "contacts"]);
  });
});
