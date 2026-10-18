import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

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

test("organization filtering preserves the previous substring predicates", () => {
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
    "organization filtering preserves the previous substring predicates",
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
        const normalizedQuery = query.toLowerCase().toWellFormed();
        const expected = {
          invitations: query
            ? generatedInvitations.filter((invitation) =>
                invitation.email
                  .toLowerCase()
                  .toWellFormed()
                  .includes(normalizedQuery),
              )
            : generatedInvitations,
          members: query
            ? generatedMembers.filter(
                (member) =>
                  member.user.name
                    .toLowerCase()
                    .toWellFormed()
                    .includes(normalizedQuery) ||
                  member.user.email
                    .toLowerCase()
                    .toWellFormed()
                    .includes(normalizedQuery),
              )
            : generatedMembers,
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
