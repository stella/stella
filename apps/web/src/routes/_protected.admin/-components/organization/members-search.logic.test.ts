import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import { filterOrganizationLists } from "@/routes/_protected.admin/-components/organization/members-search.logic";

const members = [
  { id: "name", user: { name: "Ada Lovelace", email: "ada@example.test" } },
  {
    id: "email",
    user: { name: "Grace Hopper", email: "g.hopper@example.test" },
  },
  { id: "other", user: { name: "Katherine Johnson", email: "kj@other.test" } },
];
const invitations = [
  { id: "first", email: "future@example.test" },
  { id: "second", email: "ada@example.test" },
  { id: "third", email: "other@other.test" },
];
const PROPERTY_TEXT_PARTS_MAX = 24;
const PROPERTY_MEMBERS_MAX = 16;
const PROPERTY_INVITATIONS_MAX = 12;

/**
 * The search contract: a field matches when it contains the trimmed query once
 * both are folded for search (case, accents, ligatures, Arabic variants).
 */
const matchesFolded = (field: string | null | undefined, query: string) => {
  const needle = foldSearchMatchText(query.trim().toWellFormed());
  return (
    needle === "" ||
    (field !== null &&
      field !== undefined &&
      foldSearchMatchText(field.toWellFormed()).includes(needle))
  );
};

describe("organization member and invitation search", () => {
  test("matches member names or emails and invitation emails separately", () => {
    expect(
      filterOrganizationLists({ members, invitations, query: "ADA" }),
    ).toEqual({
      members: [
        {
          id: "name",
          user: { name: "Ada Lovelace", email: "ada@example.test" },
        },
      ],
      invitations: [{ id: "second", email: "ada@example.test" }],
    });
    expect(
      filterOrganizationLists({ members, invitations, query: "hopper" })
        .members,
    ).toEqual([
      {
        id: "email",
        user: { name: "Grace Hopper", email: "g.hopper@example.test" },
      },
    ]);
    expect(
      filterOrganizationLists({ members, invitations, query: "ada hopper" }),
    ).toEqual({ members: [], invitations: [] });
    const accented = [
      { id: "cs", user: { name: "Jiří Dvořák", email: "jd@example.test" } },
    ];
    expect(
      filterOrganizationLists({
        members: accented,
        invitations: [],
        query: " DVORAK ",
      }).members,
    ).toEqual(accented);
  });

  test("keeps source order, all rows for an empty query, and empty collections", () => {
    expect(
      filterOrganizationLists({ members, invitations, query: undefined }),
    ).toEqual({ members, invitations });
    expect(
      filterOrganizationLists({ members, invitations, query: "" }),
    ).toEqual({
      members,
      invitations,
    });
    expect(
      filterOrganizationLists({ members: [], invitations: [], query: "ada" }),
    ).toEqual({ members: [], invitations: [] });
    expect(
      filterOrganizationLists({ members, invitations, query: "example.test" }),
    ).toEqual({
      members: [
        {
          id: "name",
          user: { name: "Ada Lovelace", email: "ada@example.test" },
        },
        {
          id: "email",
          user: { name: "Grace Hopper", email: "g.hopper@example.test" },
        },
      ],
      invitations: [
        { id: "first", email: "future@example.test" },
        { id: "second", email: "ada@example.test" },
      ],
    });
  });

  test("matches malformed names and invitation emails through the replacement character", () => {
    const malformedMembers = [
      {
        id: "malformed",
        user: { name: "A\ud800da", email: "ada@example.test" },
      },
    ];
    const malformedInvitations = [
      { id: "malformed", email: "future\ud800@example.test" },
    ];

    expect(
      filterOrganizationLists({
        members: malformedMembers,
        invitations: malformedInvitations,
        query: "\uFFFD",
      }),
    ).toEqual({ members: malformedMembers, invitations: malformedInvitations });
  });
});

test("organization filtering keeps exactly the rows a field of which matches", () => {
  const text = fc
    .array(
      fc.constantFrom(
        "a",
        "A",
        " ",
        "\t",
        "é",
        "e\u0301",
        "Ł",
        "İ",
        "ı",
        "ß",
        "[",
        ".",
        "😀",
        "\ud800",
        "ع",
      ),
      { maxLength: PROPERTY_TEXT_PARTS_MAX },
    )
    .map((parts) => parts.join(""));

  assertProperty(
    "organization filtering keeps exactly the rows a field of which matches",
    fc.property(
      fc.array(fc.record({ name: text, email: text }), {
        maxLength: PROPERTY_MEMBERS_MAX,
      }),
      fc.array(fc.record({ email: text }), {
        maxLength: PROPERTY_INVITATIONS_MAX,
      }),
      text,
      (memberRows, invitationRows, query) => {
        const generatedMembers = memberRows.map((member, index) => ({
          id: `member-${index}`,
          user: member,
        }));
        const generatedInvitations = invitationRows.map(
          (invitation, index) => ({
            id: `invitation-${index}`,
            ...invitation,
          }),
        );
        const expected = {
          invitations: generatedInvitations.filter((invitation) =>
            matchesFolded(invitation.email, query),
          ),
          members: generatedMembers.filter(
            (member) =>
              matchesFolded(member.user.name, query) ||
              matchesFolded(member.user.email, query),
          ),
        };

        expect(
          filterOrganizationLists({
            members: generatedMembers,
            invitations: generatedInvitations,
            query,
          }),
        ).toEqual(expected);
      },
    ),
  );
});
