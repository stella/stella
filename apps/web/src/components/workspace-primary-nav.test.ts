import { describe, expect, test } from "bun:test";

import { getWorkspacePrimaryNavItems } from "@/components/workspace-primary-nav";

const navIds = (options: {
  includeInbox: boolean;
  includePublicLaw: boolean;
  includePublicTools: boolean;
}) => getWorkspacePrimaryNavItems(options).map((item) => item.id);

describe("workspace primary nav", () => {
  test("drops only the gated entries when their gate is closed", () => {
    expect(
      navIds({
        includeInbox: false,
        includePublicLaw: false,
        includePublicTools: false,
      }),
    ).toEqual(["search", "chat", "matters", "knowledge", "contacts"]);
  });

  test("keeps the inbox entry once its gate opens", () => {
    expect(
      navIds({
        includeInbox: true,
        includePublicLaw: false,
        includePublicTools: false,
      }),
    ).toContain("inbox");
  });
});
