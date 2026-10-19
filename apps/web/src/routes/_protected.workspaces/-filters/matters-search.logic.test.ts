import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

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

const containsPreviousScalarSearchKey = (content: string, query: string) => {
  const contentScalars = Array.from(content.toWellFormed());
  const queryScalars = Array.from(query.toWellFormed());
  if (queryScalars.length === 0) {
    return true;
  }
  return contentScalars.some((_, start) =>
    queryScalars.every(
      (scalar, offset) => contentScalars.at(start + offset) === scalar,
    ),
  );
};

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

  it("keeps accent-sensitive matching and the existing whitespace-only empty behavior", () => {
    const workspaces = [
      { client: null, name: "Café matter", reference: "R-1" },
      { client: null, name: "Other", reference: "R-2" },
    ];

    expect(filterWorkspacesBySearch(workspaces, "cafe")).toEqual([]);
    expect(filterWorkspacesBySearch(workspaces, "   ")).toEqual(workspaces);
    expect(filterWorkspacesBySearch(workspaces, " café ")).toEqual([]);
  });
});

describe("client filter search", () => {
  it("trims and case-folds display names without changing order or accent behavior", () => {
    const clients = [
      { id: "b", displayName: "Case B" },
      { id: "a", displayName: "CASE A" },
      { id: "c", displayName: "Café" },
    ];

    expect(
      filterClientsBySearch(clients, " CASE ").map(({ id }) => id),
    ).toEqual(["b", "a"]);
    expect(filterClientsBySearch(clients, "cafe")).toEqual([]);
    expect(filterClientsBySearch(clients, " ")).toBe(clients);
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
    expect(filterTeamMembersBySearch(members, "")).toBe(members);
    expect(filterTeamMembersBySearch(members, " ")).toBe(members);
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

it("matter search filters match their previous per-field substring behavior", () => {
  assertProperty(
    "matter search filters match their previous per-field substring behavior",
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
        const expectedWorkspaces = workspaces.filter((workspace) => {
          if (!query.trim()) {
            return true;
          }
          const normalizedQuery = query.toLowerCase();
          return (
            containsPreviousScalarSearchKey(
              workspace.name.toLowerCase(),
              normalizedQuery,
            ) ||
            containsPreviousScalarSearchKey(
              workspace.reference.toLowerCase(),
              normalizedQuery,
            ) ||
            (workspace.client !== null &&
              containsPreviousScalarSearchKey(
                workspace.client.displayName.toLowerCase(),
                normalizedQuery,
              ))
          );
        });
        const normalizedQuery = query.trim().toLowerCase();
        const expectedClients = normalizedQuery
          ? clients.filter((client) =>
              containsPreviousScalarSearchKey(
                client.displayName.toLowerCase(),
                normalizedQuery,
              ),
            )
          : clients;
        const expectedMembers = normalizedQuery
          ? members.filter(
              (member) =>
                containsPreviousScalarSearchKey(
                  member.userName.toLowerCase(),
                  normalizedQuery,
                ) ||
                containsPreviousScalarSearchKey(
                  member.userEmail.toLowerCase(),
                  normalizedQuery,
                ) ||
                containsPreviousScalarSearchKey(
                  member.userId.toLowerCase(),
                  normalizedQuery,
                ),
            )
          : members;

        expect(filterWorkspacesBySearch(workspaces, query)).toEqual(
          expectedWorkspaces,
        );
        expect(filterClientsBySearch(clients, query)).toEqual(expectedClients);
        expect(filterTeamMembersBySearch(members, query)).toEqual(
          expectedMembers,
        );
      },
    ),
  );
});
