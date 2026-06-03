import { describe, expect, it } from "bun:test";

import {
  buildCollaboratorStats,
  compareMembersByCollaboratorStats,
  getPossibleDuplicateMatters,
  isPossibleDuplicateMatter,
} from "./create-matter-dialog.logic";

describe("isPossibleDuplicateMatter", () => {
  const workspace = {
    client: { id: "client-1" },
    members: [],
    id: "workspace-1",
    name: "Acme Employment Dispute",
    reference: "MAT-001",
  };

  it("flags exact normalized name matches for the same client", () => {
    expect(
      isPossibleDuplicateMatter({
        clientId: "client-1",
        name: "  acme   employment dispute  ",
        workspace,
      }),
    ).toBe(true);
  });

  it("flags close token-overlap matches for the same client", () => {
    expect(
      isPossibleDuplicateMatter({
        clientId: "client-1",
        name: "Acme employment dispute appeal",
        workspace,
      }),
    ).toBe(true);
  });

  it("does not flag broad substring matches with weak overlap", () => {
    expect(
      isPossibleDuplicateMatter({
        clientId: "client-1",
        name: "Acme",
        workspace,
      }),
    ).toBe(false);
  });

  it("does not flag matches for a different client", () => {
    expect(
      isPossibleDuplicateMatter({
        clientId: "client-2",
        name: "Acme Employment Dispute",
        workspace,
      }),
    ).toBe(false);
  });
});

describe("getPossibleDuplicateMatters", () => {
  it("returns only the first matching duplicates up to the limit", () => {
    const duplicates = getPossibleDuplicateMatters({
      clientId: "client-1",
      limit: 2,
      name: "Acme employment dispute",
      workspaces: [
        {
          client: { id: "client-1" },
          members: [],
          id: "workspace-1",
          name: "Acme Employment Dispute",
          reference: "MAT-001",
        },
        {
          client: { id: "client-1" },
          members: [],
          id: "workspace-2",
          name: "Acme Employment Dispute Appeal",
          reference: "MAT-002",
        },
        {
          client: { id: "client-1" },
          members: [],
          id: "workspace-3",
          name: "Acme",
          reference: "MAT-003",
        },
      ],
    });

    expect(duplicates.map((workspace) => workspace.id)).toEqual([
      "workspace-1",
      "workspace-2",
    ]);
  });
});

describe("compareMembersByCollaboratorStats", () => {
  it("prioritizes members with stronger shared collaboration signals", () => {
    const collaboratorStats = buildCollaboratorStats({
      currentUserId: "current-user",
      workspaces: [
        {
          client: { id: "client-1" },
          members: [
            {
              lastActivity: "2026-04-05T10:00:00.000Z",
              userId: "current-user",
            },
            { lastActivity: "2026-04-05T10:00:00.000Z", userId: "alice" },
          ],
          id: "workspace-1",
          name: "Matter A",
        },
        {
          client: { id: "client-1" },
          members: [
            {
              lastActivity: "2026-04-06T10:00:00.000Z",
              userId: "current-user",
            },
            { lastActivity: "2026-04-06T10:00:00.000Z", userId: "alice" },
          ],
          id: "workspace-2",
          name: "Matter B",
        },
        {
          client: { id: "client-1" },
          members: [
            { lastActivity: "2026-04-07T10:00:00.000Z", userId: "bob" },
          ],
          id: "workspace-3",
          name: "Matter C",
        },
      ],
    });

    const members = [
      { user: { name: "Bob" }, userId: "bob" },
      { user: { name: "Alice" }, userId: "alice" },
    ].toSorted((a, b) =>
      compareMembersByCollaboratorStats({
        a,
        b,
        collaboratorStats,
      }),
    );

    expect(members.map((member) => member.userId)).toEqual(["alice", "bob"]);
  });
});
