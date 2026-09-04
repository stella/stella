import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { readWorkspaceHandler } from "./get";

const ORGANIZATION_ID = toSafeId<"organization">("org_test123");
const WORKSPACE_ID = toSafeId<"workspace">("ws_test123");

// The row shape the handler's `findFirst` projection returns, including the
// `client` card it joins in. Pinned to the handler's own success branch so a
// drifting projection fails here rather than passing against a stale literal.
type ReadWorkspaceSuccess = Extract<
  Awaited<ReturnType<typeof readWorkspaceHandler>>,
  { name: string }
>;

const workspaceRow = {
  id: WORKSPACE_ID,
  organizationId: ORGANIZATION_ID,
  name: "Acme retainer",
  reference: "REF-1",
  clientId: toSafeId<"contact">("contact_test123"),
  leadUserId: null,
  billingReference: null,
  color: null,
  status: "active",
  lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  client: {
    id: toSafeId<"contact">("contact_test123"),
    type: "organization",
    displayName: "Acme s.r.o.",
    color: null,
  },
} satisfies ReadWorkspaceSuccess;

// The mock stands in for the database by applying the handler's own `where`,
// so a row the handler did not ask for is not one it can be handed. That is
// what makes the foreign-organization case below a real assertion rather than
// a restatement of the mock.
type WorkspaceQuery = {
  where: {
    id: { eq: string };
    organizationId: { eq: string };
  };
};

const readWorkspace = async (row: ReadWorkspaceSuccess | undefined) => {
  const { scopedDb } = createScopedDbMock({
    query: {
      workspaces: {
        findFirst: async ({ where }: WorkspaceQuery) =>
          row?.id === where.id.eq &&
          row.organizationId === where.organizationId.eq
            ? row
            : undefined,
      },
    },
  });
  return await readWorkspaceHandler({
    scopedDb,
    workspaceId: WORKSPACE_ID,
    organizationId: ORGANIZATION_ID,
  });
};

describe("readWorkspaceHandler", () => {
  // Matter reads are one of the hottest endpoints in the app. This response
  // once spread the whole server `LIMITS` table into every read (~7 KiB, and
  // growing with every new server-side bound) for two static product
  // constants the client now imports from `@stll/api-contract`. Pinning the
  // key set makes the next bulk table bolted onto the response fail here
  // rather than silently in the route's payload budget.
  test("returns the matter row and its client card, and nothing else", async () => {
    const result = await readWorkspace(workspaceRow);

    expect(Object.keys(result).sort()).toEqual(
      Object.keys(workspaceRow).sort(),
    );
    expect(result).toEqual(workspaceRow);
  });

  test("returns 404 when the matter does not exist", async () => {
    expect(await readWorkspace(undefined)).toMatchObject({ code: 404 });
  });

  // The organization is part of the lookup, not a check after it, so a matter
  // owned by another tenant is not among the rows the query can return and the
  // not-found path answers it.
  test("does not return a matter owned by another organization", async () => {
    const foreignRow = {
      ...workspaceRow,
      organizationId: toSafeId<"organization">("org_other456"),
    };

    expect(await readWorkspace(foreignRow)).toMatchObject({ code: 404 });
  });
});
