import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import {
  filterClientsBySearch,
  filterTeamMembersBySearch,
  filterWorkspacesBySearch,
} from "./matters-search.logic";

const SEARCH_TEXT_MAX_CHARACTERS = 24;
const GENERATED_SEARCH_RECORDS_MAX_COUNT = 30;

const searchText = fc
  .array(
    fc.constantFrom(
      "A",
      "a",
      "Č",
      "č",
      "é",
      "e\u0301",
      "[",
      "]",
      " ",
      "\t",
      "😀",
      "\ud800",
      "\udc00",
    ),
    { maxLength: SEARCH_TEXT_MAX_CHARACTERS },
  )
  .map((characters) => characters.join(""));

/**
 * The contract every filter here keeps: a record stays when one of its fields
 * contains the trimmed query once both are folded for search.
 */
const matchesFolded = (field: string, query: string) =>
  foldSearchMatchText(field.toWellFormed()).includes(
    foldSearchMatchText(query.trim().toWellFormed()),
  );

describe("matter list search", () => {
  it("matches name, reference, or client display name, preserving input order", () => {
    const workspaces = [
      {
        client: { displayName: "Match client" },
        name: "Other",
        reference: "R-1",
      },
      { client: null, name: "Match by name", reference: "R-2" },
      { client: null, name: "Other", reference: "MATCH-3" },
    ];

    expect(filterWorkspacesBySearch(workspaces, "match")).toEqual(workspaces);
  });

  it("ignores accents and case on both sides; a blank query keeps every matter", () => {
    const workspaces = [
      { client: null, name: "Café matter", reference: "R-1" },
      {
        client: { displayName: "Antonín Dvořák" },
        name: "Lease",
        reference: "R-2",
      },
      { client: null, name: "Other", reference: "Straße-3" },
    ];

    expect(filterWorkspacesBySearch(workspaces, "cafe")).toEqual(
      workspaces.slice(0, 1),
    );
    expect(filterWorkspacesBySearch(workspaces, " CAFÉ ")).toEqual(
      workspaces.slice(0, 1),
    );
    expect(filterWorkspacesBySearch(workspaces, "dvorak")).toEqual(
      workspaces.slice(1, 2),
    );
    expect(filterWorkspacesBySearch(workspaces, "strasse")).toEqual(
      workspaces.slice(2),
    );
    expect(filterWorkspacesBySearch(workspaces, "   ")).toEqual(workspaces);
  });
});

describe("client filter search", () => {
  it("trims and folds display names without changing order", () => {
    const clients = [
      { id: "b", displayName: "Case B" },
      { id: "a", displayName: "CASE A" },
      { id: "c", displayName: "Café" },
    ];

    expect(
      filterClientsBySearch(clients, " CASE ").map(({ id }) => id),
    ).toEqual(["b", "a"]);
    expect(filterClientsBySearch(clients, "cafe")).toEqual(clients.slice(2));
    expect(filterClientsBySearch(clients, " ")).toEqual(clients);
  });
});

describe("team filter search", () => {
  it("searches name, email, and id independently and preserves order", () => {
    const members = [
      { userId: "id-1", userEmail: "other@example.test", userName: "Other" },
      { userId: "other", userEmail: "MATCH@example.test", userName: "Person" },
      {
        userId: "MATCH-id",
        userEmail: "other@example.test",
        userName: "Person",
      },
    ];

    expect(filterTeamMembersBySearch(members, " match ")).toEqual([
      { userId: "other", userEmail: "MATCH@example.test", userName: "Person" },
      {
        userId: "MATCH-id",
        userEmail: "other@example.test",
        userName: "Person",
      },
    ]);
    expect(filterTeamMembersBySearch(members, "")).toEqual(members);
    expect(filterTeamMembersBySearch(members, " ")).toEqual(members);
    expect(
      filterTeamMembersBySearch(
        [
          {
            userId: "u",
            userEmail: "jd@example.test",
            userName: "Jiří Dvořák",
          },
        ],
        "jiri dvorak",
      ),
    ).toHaveLength(1);
  });
});

it("matches malformed matter fields by replacement scalar without matching emoji", () => {
  const workspaces = [
    { client: null, name: "\ud800", reference: "R-1" },
    { client: null, name: "😀", reference: "R-2" },
  ];
  const clients = [
    { id: "malformed", displayName: "\ud800" },
    { id: "emoji", displayName: "😀" },
  ];
  const members = [
    { userId: "malformed", userEmail: "", userName: "\ud800" },
    { userId: "emoji", userEmail: "", userName: "😀" },
  ];

  expect(filterWorkspacesBySearch(workspaces, "\udc00")).toEqual(
    workspaces.slice(0, 1),
  );
  expect(filterClientsBySearch(clients, "\udc00")).toEqual(clients.slice(0, 1));
  expect(filterTeamMembersBySearch(members, "\udc00")).toEqual(
    members.slice(0, 1),
  );
  expect(filterWorkspacesBySearch(workspaces, "\ufffd")).toEqual(
    workspaces.slice(0, 1),
  );
  expect(filterClientsBySearch(clients, "\ufffd")).toEqual(clients.slice(0, 1));
  expect(filterTeamMembersBySearch(members, "\ufffd")).toEqual(
    members.slice(0, 1),
  );
});

it("matter search filters keep exactly the records a field of which matches", () => {
  assertProperty(
    "matter search filters keep exactly the records a field of which matches",
    fc.property(
      fc.array(
        fc.record({
          client: fc.option(fc.record({ displayName: searchText }), {
            nil: null,
          }),
          name: searchText,
          reference: searchText,
        }),
        { maxLength: GENERATED_SEARCH_RECORDS_MAX_COUNT },
      ),
      fc.array(fc.record({ displayName: searchText, id: fc.string() }), {
        maxLength: GENERATED_SEARCH_RECORDS_MAX_COUNT,
      }),
      fc.array(
        fc.record({
          userEmail: searchText,
          userId: searchText,
          userName: searchText,
        }),
        { maxLength: GENERATED_SEARCH_RECORDS_MAX_COUNT },
      ),
      searchText,
      (workspaces, clients, members, query) => {
        expect(filterWorkspacesBySearch(workspaces, query)).toEqual(
          workspaces.filter(
            (workspace) =>
              matchesFolded(workspace.name, query) ||
              matchesFolded(workspace.reference, query) ||
              (workspace.client !== null &&
                matchesFolded(workspace.client.displayName, query)),
          ),
        );
        expect(filterClientsBySearch(clients, query)).toEqual(
          clients.filter((client) => matchesFolded(client.displayName, query)),
        );
        expect(filterTeamMembersBySearch(members, query)).toEqual(
          members.filter(
            (member) =>
              matchesFolded(member.userName, query) ||
              matchesFolded(member.userEmail, query) ||
              matchesFolded(member.userId, query),
          ),
        );
      },
    ),
  );
});
