import { Result } from "better-result";
import { expect, test } from "bun:test";

import { ClientOperationError } from "@/lib/errors/client";

import { classifySharepointConnectionResponse } from "./connections";

test("recognizes only the deployed pre-capability SharePoint response", () => {
  expect(
    classifySharepointConnectionResponse({ connection: null }).unwrap(),
  ).toEqual({
    type: "upgrade_required",
  });
  expect(
    classifySharepointConnectionResponse({
      connection: { id: "old-connection", status: "connected" },
    }).unwrap(),
  ).toEqual({ type: "upgrade_required" });
  const current = {
    policy: {
      sharepointConnectionEnabled: false,
      microsoft365CalendarReadEnabled: true,
    },
    enabledCapabilities: ["calendar.read"],
    connection: { capabilities: ["calendar.read"] },
  };
  expect(classifySharepointConnectionResponse(current).unwrap()).toEqual({
    type: "ready",
    value: current,
  });
  for (const malformed of [
    {},
    { connection: null, enabledCapabilities: ["calendar.read"] },
  ]) {
    const result = classifySharepointConnectionResponse(malformed);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(ClientOperationError.is(result.error)).toBe(true);
      expect(result.error.message).toBe(
        "Invalid SharePoint connection response",
      );
      expect(result.error.action).toBe("read-sharepoint-connection");
    }
  }
});
