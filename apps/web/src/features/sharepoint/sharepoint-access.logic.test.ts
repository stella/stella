import { describe, expect, test } from "bun:test";

import {
  SHAREPOINT_ACCESS,
  SHAREPOINT_CONNECTION_STATE,
  sharepointAccessFromRefusal,
  sharepointConnectionState,
} from "./sharepoint-access.logic";

describe("SharePoint gate", () => {
  test("a deployment without SharePoint answers 404, which hides it", () => {
    expect(
      sharepointAccessFromRefusal({ status: 404, transport: false }),
    ).toEqual({ type: SHAREPOINT_ACCESS.unavailable });
  });

  test("an organization that has not opted in answers 403", () => {
    expect(
      sharepointAccessFromRefusal({ status: 403, transport: false }),
    ).toEqual({ type: SHAREPOINT_ACCESS.disabled });
  });

  test("an outage or a request that never got an answer is a failure, not a gate", () => {
    for (const status of [400, 409, 429, 500, 502, 503]) {
      expect(
        sharepointAccessFromRefusal({ status, transport: false }),
      ).toBeNull();
    }
    expect(
      sharepointAccessFromRefusal({ status: 404, transport: true }),
    ).toBeNull();
    expect(
      sharepointAccessFromRefusal({ status: 0, transport: true }),
    ).toBeNull();
  });
});

describe("SharePoint connection state", () => {
  test("follows the stored connection", () => {
    expect(sharepointConnectionState(null)).toBe(
      SHAREPOINT_CONNECTION_STATE.notConnected,
    );
    expect(sharepointConnectionState({ status: "connected" })).toBe(
      SHAREPOINT_CONNECTION_STATE.connected,
    );
    expect(sharepointConnectionState({ status: "reconnect_required" })).toBe(
      SHAREPOINT_CONNECTION_STATE.reconnectRequired,
    );
  });
});
