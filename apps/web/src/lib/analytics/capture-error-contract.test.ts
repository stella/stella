import { describe, expect, test } from "bun:test";

import type { Analytics } from "@/lib/analytics/types";
import { APIError, toAPIError } from "@/lib/errors/api";

const recorded: unknown[] = [];
const captureError: Analytics["captureError"] = (error) => {
  recorded.push(error);
};

describe("captureError contract", () => {
  test("rejects a raw Eden error envelope at compile time", () => {
    const envelope = { status: 500, value: { message: "boom" } };
    // @ts-expect-error a raw envelope drops the API status and code; pass toAPIError(envelope)
    captureError(envelope, {
      fingerprintKey: "contract:raw-envelope",
      scope: { type: "handler", handlerId: "contract:raw-envelope" },
    });
    const captureMaybe = (maybe: typeof envelope | null) => {
      // @ts-expect-error a nullable envelope is still an envelope
      captureError(maybe, {
        fingerprintKey: "contract:nullable-envelope",
        scope: { type: "handler", handlerId: "contract:nullable-envelope" },
      });
    };
    captureMaybe(null);
    captureError(toAPIError(envelope), {
      fingerprintKey: "contract:api-error",
      scope: { type: "handler", handlerId: "contract:api-error" },
    });

    expect(recorded.at(-1)).toBeInstanceOf(APIError);
  });

  test("accepts catch-clause unknowns and errors", () => {
    const caught: unknown = new Error("caught");
    captureError(caught, {
      fingerprintKey: "contract:caught",
      scope: { type: "handler", handlerId: "contract:caught" },
    });
    captureError(new Error("plain"), {
      fingerprintKey: "contract:plain",
      scope: { type: "handler", handlerId: "contract:plain" },
    });
    captureError(new APIError({ status: 404, message: "missing" }), {
      fingerprintKey: "contract:api",
      scope: { type: "handler", handlerId: "contract:api" },
    });

    expect(recorded.slice(-3)).toHaveLength(3);
  });
});

// Stack presence is a runtime property: every manual capture requires an owner.
const framelessCaptureContract = (error: unknown) => {
  // @ts-expect-error frameless failures require an explicit stable owner/path key
  captureError(error);
  captureError(error, {
    // @ts-expect-error free-form text cannot serve as a fingerprint key
    fingerprintKey: "no-owner",
    scope: { type: "handler", handlerId: "no-owner" },
  });
};
void framelessCaptureContract;

const requiredScopeContract = (error: unknown) => {
  // @ts-expect-error a key does not declare the owning request or handler scope
  captureError(error, { fingerprintKey: "contract:missing-scope" });
};
void requiredScopeContract;
