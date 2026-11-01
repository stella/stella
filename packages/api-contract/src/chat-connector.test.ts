import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  connectConnectorInputSchema,
  connectConnectorOutputSchema,
  connectConnectorSubmissionSchema,
} from "./chat-connector";

describe("connect_connector contract", () => {
  test("round-trips every receipt through JSON", () => {
    for (const receipt of [
      { status: "connected", connectorSlug: "sample-connector" },
      { status: "declined", connectorSlug: "sample-connector" },
    ] as const) {
      const wire = JSON.stringify(receipt);
      const parsed = v.parse(connectConnectorOutputSchema, JSON.parse(wire));
      expect(parsed).toEqual(receipt);
    }
  });

  test("bounds the slug and purpose and rejects extra fields", () => {
    const valid = { connectorSlug: "sample", purpose: "Read the source" };
    expect(v.is(connectConnectorInputSchema, valid)).toBe(true);
    for (const invalid of [
      { ...valid, connectorSlug: "" },
      { ...valid, connectorSlug: "s".repeat(81) },
      { ...valid, purpose: "" },
      { ...valid, purpose: "p".repeat(501) },
      { ...valid, token: "value" },
    ]) {
      expect(v.is(connectConnectorInputSchema, invalid)).toBe(false);
    }
    expect(
      v.is(connectConnectorOutputSchema, {
        status: "connected",
        connectorSlug: "sample",
        secretRef: "value",
      }),
    ).toBe(false);
  });

  test("accepts only the two card decisions", () => {
    expect(
      v.is(connectConnectorSubmissionSchema, { decision: "connected" }),
    ).toBe(true);
    expect(
      v.is(connectConnectorSubmissionSchema, { decision: "declined" }),
    ).toBe(true);
    expect(
      v.is(connectConnectorSubmissionSchema, { decision: "provide" }),
    ).toBe(false);
  });
});
