import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "bun:test";
import { IntlProvider } from "use-intl";

import { getInitials } from "@stll/ui/initials";

import { getDisplayName } from "@/lib/get-display-name";

import { TeamAvatars } from "./team-avatars";

describe("team avatar labels", () => {
  it("derives stable initials from names", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL");
    expect(getInitials("  mary   shelley  ")).toBe("MS");
    expect(getInitials("Plato")).toBe("PL");
  });

  it("uses the canonical fallback when an auth user has no display name", () => {
    expect(getInitials(null)).toBe("?");
    expect(getInitials(" ")).toBe("?");
    expect(getDisplayName(null, "ada@example.com")).toBe("ada@example.com");
    expect(getDisplayName("", null)).toBeNull();
  });
});

const renderAvatars = (props: Parameters<typeof TeamAvatars>[0]) =>
  renderToStaticMarkup(
    createElement(IntlProvider, {
      locale: "en",
      messages: {
        common: { unknownUser: "Unknown user" },
        workspaces: { lead: "Lead" },
      },
      children: createElement(TeamAvatars, props),
    }),
  );

const members = Array.from({ length: 4 }, (_, index) => ({
  userId: `user-${index}`,
  userName: `Member ${index}`,
  userEmail: `member-${index}@example.test`,
  userImage: null,
}));

describe("team avatar overflow", () => {
  it("uses the full count for bounded previews and retains full-list counts", () => {
    expect(renderAvatars({ members, leadUserId: null })).toContain("+1");
    expect(
      renderAvatars({
        members: members.slice(0, 3),
        leadUserId: null,
        totalCount: 8,
      }),
    ).toContain("+5");
  });

  it("honors an explicit empty fallback", () => {
    expect(
      renderAvatars({ members: [], leadUserId: null, emptyFallback: null }),
    ).toBe("");
  });
});
