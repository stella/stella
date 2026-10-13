import { expect, test } from "bun:test";

import { areEntityTransfersAvailable } from "@/lib/workspaces/queries/transfer-eligibility.logic";

test("a folder transfer waits for the server decision", () => {
  expect(
    areEntityTransfersAvailable({
      entityIds: ["folder-a"],
      transfers: undefined,
    }),
  ).toBe(false);
  expect(
    areEntityTransfersAvailable({
      entityIds: ["folder-a"],
      transfers: [{ entityId: "folder-a", access: "unavailable" }],
    }),
  ).toBe(false);
  expect(
    areEntityTransfersAvailable({
      entityIds: ["folder-a"],
      transfers: [{ entityId: "folder-a", access: "available" }],
    }),
  ).toBe(true);
});

test("a selection requires an available decision for every selected root", () => {
  const transfers = [
    { entityId: "folder-a", access: "available" },
    { entityId: "folder-b", access: "unavailable" },
  ];
  expect(
    areEntityTransfersAvailable({
      entityIds: ["folder-a", "folder-b"],
      transfers,
    }),
  ).toBe(false);
  expect(
    areEntityTransfersAvailable({
      entityIds: ["folder-a", "folder-c"],
      transfers,
    }),
  ).toBe(false);
  expect(areEntityTransfersAvailable({ entityIds: [], transfers })).toBe(false);
});
