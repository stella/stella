import { describe, expect, it } from "bun:test";

import { withDragAnnouncementData } from "@/components/drag-and-drop-live-region.logic";
import { toSafeId } from "@/lib/safe-id";
import { ENTITY_DRAG_TYPE } from "@/lib/workspaces/drag-constants";
import type { WorkspaceGroup } from "@/lib/workspaces/types";
import { PERSONAL_GROUP_ID } from "@/lib/workspaces/types";

import {
  readMatterCardDragData,
  resolveMatterClientDrop,
  toMatterCardDragData,
} from "./matter-client-drop.logic";

const clientGroup = (clientId: string, clientName: string) =>
  ({
    type: "client",
    groupId: clientId,
    clientId,
    clientName,
    responsibleAttorneyName: null,
    workspaces: [],
  }) satisfies WorkspaceGroup;

const PERSONAL_GROUP = {
  type: "personal",
  groupId: PERSONAL_GROUP_ID,
  workspaces: [],
} satisfies WorkspaceGroup;
const NOVAK_GROUP = clientGroup("client-novak", "Novák s.r.o.");
const BERGER_GROUP = clientGroup("client-berger", "Berger GmbH");

const personalMatter = toMatterCardDragData({
  id: toSafeId<"workspace">("matter-lease"),
  name: "Lease review",
  client: null,
});
const novakMatter = toMatterCardDragData({
  id: toSafeId<"workspace">("matter-merger"),
  name: "Merger due diligence",
  client: { id: toSafeId<"contact">(NOVAK_GROUP.clientId) },
});

describe("dropping a matter card on a client group", () => {
  it("moves a client matter to a different client", () => {
    expect(
      resolveMatterClientDrop({ source: novakMatter, group: BERGER_GROUP }),
    ).toEqual({
      type: "move",
      matterId: "matter-merger",
      matterName: "Merger due diligence",
      clientId: "client-berger",
      clientName: "Berger GmbH",
    });
  });

  it("promotes a personal matter onto a client", () => {
    expect(
      resolveMatterClientDrop({ source: personalMatter, group: NOVAK_GROUP }),
    ).toEqual({
      type: "promote",
      matterId: "matter-lease",
      matterName: "Lease review",
      clientId: "client-novak",
      clientName: "Novák s.r.o.",
    });
  });

  it("rejects the matter's own client group", () => {
    expect(
      resolveMatterClientDrop({ source: novakMatter, group: NOVAK_GROUP }),
    ).toEqual({ type: "rejected" });
  });

  it("rejects the personal group from every origin", () => {
    for (const source of [personalMatter, novakMatter]) {
      expect(
        resolveMatterClientDrop({ source, group: PERSONAL_GROUP }),
      ).toEqual({ type: "rejected" });
    }
  });
});

describe("reading drag payloads", () => {
  it("reads a matter card payload carrying announcement data", () => {
    const data = withDragAnnouncementData(
      { ...novakMatter },
      novakMatter.matterName,
    );

    expect(readMatterCardDragData(data)).toEqual(novakMatter);
  });

  it("ignores drags of other kinds", () => {
    expect(
      readMatterCardDragData({ type: ENTITY_DRAG_TYPE, entities: [] }),
    ).toBeNull();
    expect(
      readMatterCardDragData({ ...novakMatter, origin: { type: "client" } }),
    ).toBeNull();
  });
});
