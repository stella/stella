import { expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { createWorkspaceAccessBoundary } from "./workspace-access-boundary";

test("mutating the exposed access set cannot widen the private pin boundary", () => {
  const allowedWorkspaceId = toSafeId<"workspace">("ws_allowed");
  const inaccessibleWorkspaceId = toSafeId<"workspace">("ws_inaccessible");
  const boundary = createWorkspaceAccessBoundary([allowedWorkspaceId]);
  const requestPin = mock(() => true);
  const boundedPin = boundary.bindWorkspacePin(requestPin);

  boundary.accessibleWorkspaceIdSet.add(inaccessibleWorkspaceId);

  expect(boundedPin(inaccessibleWorkspaceId)).toBe(false);
  expect(requestPin).not.toHaveBeenCalled();
  expect(boundedPin(allowedWorkspaceId)).toBe(true);
  expect(requestPin).toHaveBeenCalledWith(allowedWorkspaceId);
});
