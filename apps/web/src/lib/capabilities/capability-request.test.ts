import { describe, expect, test } from "bun:test";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";

import {
  capabilityRequest,
  invokeCapability,
} from "@/lib/capabilities/capability-request";
import type { CapabilityRequest } from "@/lib/capabilities/capability-request";

describe("capability requests", () => {
  test("declare the capability in the request headers", () => {
    expect(capabilityRequest("chat.threads.update")).toEqual({
      headers: { [CAPABILITY_REQUEST_HEADER]: "chat.threads.update" },
    });
  });

  test("hand the declaring options to the write and return its result", async () => {
    const seen: CapabilityRequest[] = [];
    const result = await invokeCapability(
      "billing-codes.create",
      async (request) => {
        seen.push(request);
        return await Promise.resolve("created");
      },
    );

    expect(result).toBe("created");
    expect(seen).toEqual([capabilityRequest("billing-codes.create")]);
  });
});
