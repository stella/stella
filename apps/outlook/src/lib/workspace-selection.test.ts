import { describe, expect, test } from "bun:test";

import { toSafeId } from "@stll/api/types";

import {
  filterWorkspaces,
  suggestWorkspaceId,
} from "@/lib/workspace-selection";
import type { MailSnapshot, WorkspaceSummary } from "@/types";

const workspaces: WorkspaceSummary[] = [
  {
    clientName: "Acme GmbH",
    id: toSafeId<"workspace">("matter-acme"),
    lastActivityAt: null,
    name: "Acme acquisition",
    reference: "M-2026-041",
  },
  {
    clientName: "Globex",
    id: toSafeId<"workspace">("matter-globex"),
    lastActivityAt: null,
    name: "Globex financing",
    reference: "M-2026-099",
  },
];

const acmeWorkspace = workspaces[0];

if (!acmeWorkspace) {
  throw new Error("Expected Acme workspace fixture");
}

describe("suggestWorkspaceId", () => {
  test("does not silently choose the first matter when there is no match", () => {
    expect(
      suggestWorkspaceId({
        snapshot: snapshot({ subject: "Unrelated correspondence" }),
        workspaces,
      }),
    ).toBeNull();
  });

  test("prefers an exact matter reference", () => {
    expect(
      suggestWorkspaceId({
        snapshot: snapshot({ subject: "Re: M-2026-099 closing" }),
        workspaces,
      }),
    ).toBe("matter-globex");
  });

  test("matches normalized names across punctuation and diacritics", () => {
    expect(
      suggestWorkspaceId({
        snapshot: snapshot({
          bodyText: "Status for ACME-GmbH",
          subject: "Status",
        }),
        workspaces,
      }),
    ).toBe("matter-acme");
  });

  test("requires an unambiguous best match", () => {
    expect(
      suggestWorkspaceId({
        snapshot: snapshot({ subject: "Acme acquisition" }),
        workspaces: [
          acmeWorkspace,
          { ...acmeWorkspace, id: toSafeId<"workspace">("matter-copy") },
        ],
      }),
    ).toBeNull();
  });
});

describe("filterWorkspaces", () => {
  test("searches matter, reference, and client metadata", () => {
    expect(
      filterWorkspaces({ query: "2026 041", workspaces }).map(
        (workspace) => workspace.id,
      ),
    ).toEqual([toSafeId<"workspace">("matter-acme")]);
  });
});

const snapshot = ({
  bodyText = "",
  subject,
}: {
  bodyText?: string;
  subject: string;
}): MailSnapshot => ({
  attachments: [],
  bcc: [],
  bodyText,
  cc: [],
  conversationId: null,
  from: { email: "client@example.com", name: "Client" },
  internetMessageId: null,
  itemInstanceKey: "test-item",
  itemId: "item",
  mode: "read",
  sentAt: null,
  subject,
  to: [],
  userEmail: "lawyer@example.org",
});
