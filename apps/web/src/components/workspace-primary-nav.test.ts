import { describe, expect, test } from "bun:test";

import { getWorkspacePrimaryNavItems } from "@/components/workspace-primary-nav";

const ALL_GATES_OPEN = {
  includeBilling: true,
  includeInbox: true,
  includePublicLaw: true,
  includePublicTools: true,
  includeTimesheets: true,
  publicKnowledge: false,
};

const navIds = (overrides: Partial<typeof ALL_GATES_OPEN>) =>
  getWorkspacePrimaryNavItems({ ...ALL_GATES_OPEN, ...overrides }).map(
    (item) => item.id,
  );

const publicNavIds = (overrides: Partial<typeof ALL_GATES_OPEN>) =>
  getWorkspacePrimaryNavItems({ ...ALL_GATES_OPEN, ...overrides })
    .filter((item) => item.audience === "public")
    .map((item) => item.id);

describe("workspace primary nav", () => {
  test("keeps guest access beside the canonical destination", () => {
    expect(publicNavIds({})).toEqual(["caseLaw", "tools"]);
  });

  test("offers Knowledge to guests, with the tools inside it, once it is readable without an account", () => {
    expect(publicNavIds({ publicKnowledge: true })).toEqual([
      "caseLaw",
      "knowledge",
    ]);
    expect(navIds({ publicKnowledge: true })).not.toContain("tools");
    expect(
      navIds({ publicKnowledge: true, includePublicTools: false }),
    ).toContain("knowledge");
  });

  test("keeps every entry while all gates are open", () => {
    expect(navIds({})).toEqual([
      "search",
      "chat",
      "inbox",
      "matters",
      "timesheets",
      "billing",
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
    expect(navIds({ includeTimesheets: false })).not.toContain("timesheets");
    expect(navIds({ includeBilling: false })).not.toContain("billing");
  });

  test("leaves the ungated entries alone when every gate closes", () => {
    expect(
      navIds({
        includeInbox: false,
        includePublicLaw: false,
        includePublicTools: false,
        includeTimesheets: false,
        includeBilling: false,
      }),
    ).toEqual(["search", "chat", "matters", "knowledge", "contacts"]);
  });
});
