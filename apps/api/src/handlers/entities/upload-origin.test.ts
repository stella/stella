import { describe, expect, test } from "bun:test";

import {
  UPLOAD_ENTITY_ORIGIN,
  uploadTriggeredFlowPolicy,
} from "@/api/handlers/entities/upload-origin";

describe("uploaded entity flow-trigger policy", () => {
  test("starts upload automations only for explicit user uploads", () => {
    expect(uploadTriggeredFlowPolicy(UPLOAD_ENTITY_ORIGIN.USER)).toBe("start");
    expect(
      uploadTriggeredFlowPolicy(UPLOAD_ENTITY_ORIGIN.GENERATED_DOCUMENT),
    ).toBe("skip");
  });
});
