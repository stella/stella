import { expect, test } from "bun:test";

import { ClientOperationError } from "@/lib/errors/client";

import { classifySharepointConnectionResponse } from "./connections";

test("recognizes only the deployed pre-capability SharePoint response", () => {
  expect(classifySharepointConnectionResponse({ connection: null })).toEqual({
    type: "upgrade_required",
  });
  expect(
    classifySharepointConnectionResponse({
      connection: { id: "old-connection", status: "connected" },
    }),
  ).toEqual({ type: "upgrade_required" });
  const current = {
    policy: {
      sharepointConnectionEnabled: false,
      microsoft365CalendarReadEnabled: true,
    },
    enabledCapabilities: ["calendar.read"],
    connection: { capabilities: ["calendar.read"] },
  };
  expect(classifySharepointConnectionResponse(current)).toEqual({
    type: "ready",
    value: current,
  });
  expect(() => classifySharepointConnectionResponse({})).toThrow(
    ClientOperationError,
  );
  expect(() =>
    classifySharepointConnectionResponse({
      connection: null,
      enabledCapabilities: ["calendar.read"],
    }),
  ).toThrow(ClientOperationError);
});
