import { describe, expect, it } from "bun:test";

import {
  dialogMatterVisibility,
  getPossibleDuplicateMatters,
  isPossibleDuplicateMatter,
} from "@/components/workspaces/create-matter-dialog.logic";

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

describe("dialogMatterVisibility", () => {
  it("defaults a matter without a client to its creator only", () => {
    expect(dialogMatterVisibility({ chosen: null, hasClient: false })).toBe(
      "assigned_only",
    );
  });

  it("follows the client field until the user chooses", () => {
    expect(dialogMatterVisibility({ chosen: null, hasClient: true })).toBe(
      "admins_and_assigned",
    );
  });

  it("keeps an explicit choice whether or not a client is set", () => {
    for (const hasClient of [true, false]) {
      expect(dialogMatterVisibility({ chosen: "all_members", hasClient })).toBe(
        "all_members",
      );
    }
  });
});
