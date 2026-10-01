import { describe, expect, test } from "bun:test";

import { createStellaEdenClient } from "@stll/api-client";
import type { EdenRoutesApp } from "@stll/api-client";
import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
  type ActionAdmissionRefusal,
} from "@stll/api-contract/action-admission";

import type { WebRoutes } from "@/generated/api-routes.gen";
import { actionAdmissionOutcome } from "@/lib/errors/action-admission";
import { observeActionAdmissionResponse } from "@/lib/errors/action-admission-response";
import { ClientTelemetryError } from "@/lib/errors/telemetry";

describe("action response observation", () => {
  test("all refusal codes are observed without replacing or consuming the transport response", async () => {
    for (const code of Object.values(ACTION_ADMISSION_CODES)) {
      const refusal = ACTION_ADMISSION_REFUSALS[code];
      const payload = {
        code,
        message: refusal.message,
        hint: refusal.hint,
        retryable: refusal.retryable,
        contactUrl: "https://example.test/help",
      } as const satisfies ActionAdmissionRefusal;
      const response = Response.json(payload, {
        status: refusal.status,
        headers: { "x-receipt-id": "receipt-example" },
      });
      const observed: ReturnType<typeof actionAdmissionOutcome>[] = [];
      const failures: unknown[] = [];
      await observeActionAdmissionResponse(response, {
        notifyRefusal: (error) => {
          observed.push(actionAdmissionOutcome(error));
          return true;
        },
        captureError: (error) => {
          failures.push(error);
        },
      });
      expect(response.bodyUsed).toBe(false);
      expect(response.status).toBe(refusal.status);
      expect(response.headers.get("x-receipt-id")).toBe("receipt-example");
      expect(await response.json()).toEqual(payload);
      expect(observed.map((outcome) => outcome?.code)).toEqual([code]);
      expect(failures).toEqual([]);
    }
  });

  test("success and non-JSON responses pass through without inspection", async () => {
    for (const response of [
      Response.json({ message: "Ready" }),
      Response.json({ message: "Missing" }, { status: 404 }),
      new Response("Unavailable", { status: 503 }),
    ]) {
      let notifications = 0;
      let captures = 0;
      await observeActionAdmissionResponse(response, {
        notifyRefusal: () => {
          notifications += 1;
          return true;
        },
        captureError: () => {
          captures += 1;
        },
      });
      expect(response.bodyUsed).toBe(false);
      expect(notifications).toBe(0);
      expect(captures).toBe(0);
    }
  });

  test("invalid JSON is captured without changing Eden's response handling", async () => {
    const response = new Response("Invalid JSON", {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    const captured: unknown[] = [];
    await observeActionAdmissionResponse(response, {
      notifyRefusal: () => false,
      captureError: (error) => {
        captured.push(error);
      },
    });
    expect(captured).toHaveLength(1);
    expect(ClientTelemetryError.is(captured.at(0))).toBe(true);
    const failure = captured.at(0);
    if (ClientTelemetryError.is(failure)) {
      expect(failure.cause).toBeUndefined();
    }
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("Invalid JSON");
  });

  test("presentation failure is captured rather than thrown into the transport", async () => {
    const response = Response.json(
      { code: "action_not_enabled", message: "Refused" },
      { status: 403 },
    );
    const captured: unknown[] = [];
    await observeActionAdmissionResponse(response, {
      notifyRefusal: () => {
        throw new TypeError("Presentation unavailable");
      },
      captureError: (error) => {
        captured.push(error);
      },
    });
    expect(captured).toHaveLength(1);
    expect(ClientTelemetryError.is(captured.at(0))).toBe(true);
    const failure = captured.at(0);
    if (ClientTelemetryError.is(failure)) {
      expect(failure.cause).toBeUndefined();
    }
    expect(response.bodyUsed).toBe(false);
  });
});

test("the installed Eden hook preserves refused status, error payload and headers", async () => {
  for (const code of Object.values(ACTION_ADMISSION_CODES)) {
    const refusal = ACTION_ADMISSION_REFUSALS[code];
    const payload = {
      code,
      message: refusal.message,
      hint: refusal.hint,
      retryable: refusal.retryable,
    } as const satisfies ActionAdmissionRefusal;
    const observed: unknown[] = [];
    const captured: unknown[] = [];
    const client = createStellaEdenClient<
      EdenRoutesApp<Pick<WebRoutes, "health">>
    >("https://api.example.test", {
      fetcher: Object.assign(
        async () =>
          Response.json(payload, {
            status: refusal.status,
            headers: { "x-receipt-id": "receipt-example" },
          }),
        { preconnect: () => undefined },
      ),
      onResponse: async (response) => {
        await observeActionAdmissionResponse(response, {
          notifyRefusal: (error) => {
            observed.push(actionAdmissionOutcome(error)?.code);
            return true;
          },
          captureError: (error) => {
            captured.push(error);
          },
        });
      },
    });
    const result = await client.health.get();
    expect(result.status).toBe(refusal.status);
    expect(result.data).toBeNull();
    expect(result.error?.value).toEqual(payload);
    expect(new Headers(result.headers).get("x-receipt-id")).toBe(
      "receipt-example",
    );
    expect(observed).toEqual([code]);
    expect(captured).toEqual([]);
  }
});
