import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { MANAGED_AI_RESIDENCIES } from "@/api/lib/chat/ai-data-policy";
import {
  createManagedProviderAvailability,
  ManagedProviderCheckError,
} from "@/api/lib/chat/managed-provider-availability";
import { MANAGED_PROVIDER_UNAVAILABLE_CODE } from "@/api/lib/chat/provider-data-policy";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";

const MODEL = "fixture/model";
const catalog = (ids: string[]) =>
  Response.json({ data: ids.map((id) => ({ id })) });

const fixture = (
  fetchCatalog: Parameters<
    typeof createManagedProviderAvailability
  >[0]["fetchCatalog"],
) => {
  let time = 7;
  const monitor = createManagedProviderAvailability({
    apiKey: "fixture-key",
    intervalMs: 53,
    timeoutMs: 11,
    fetchCatalog,
    now: () => time,
  });
  return {
    ...monitor,
    advance: (ms: number) => {
      time += ms;
    },
  };
};

describe("regional catalog availability", () => {
  test.each(MANAGED_AI_RESIDENCIES)(
    "starts closed, checks the %s host and retention filter, then expires",
    async (residency) => {
      const requests: URL[] = [];
      const monitor = fixture(async (url, init) => {
        requests.push(new URL(url));
        expect(init.headers).toEqual({ Authorization: "Bearer fixture-key" });
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return catalog([MODEL]);
      });
      expect(monitor.check(MODEL, residency).isErr()).toBe(true);
      expect((await monitor.refresh()).every((result) => result.isOk())).toBe(
        true,
      );
      expect(requests).toHaveLength(MANAGED_AI_RESIDENCIES.length);
      const request = requests.find((url) =>
        url.hostname.startsWith(`${residency}.`),
      );
      expect(request?.href).toBe(
        `https://${residency}.openrouter.ai/api/v1/models?region=${residency}&zdr=true`,
      );
      expect(monitor.check(MODEL, residency).isOk()).toBe(true);
      expect(monitor.check("fixture/missing", residency).isErr()).toBe(true);
      monitor.advance(53);
      const expired = monitor.check(MODEL, residency);
      expect(expired.isErr()).toBe(true);
      if (Result.isError(expired)) {
        expect(expired.error.code).toBe(MANAGED_PROVIDER_UNAVAILABLE_CODE);
      }
    },
  );

  for (const residency of MANAGED_AI_RESIDENCIES) {
    for (const missing of ["host", "retention"] as const) {
      test(`refuses a model missing ${missing} in ${residency} while preserving the other residency`, async () => {
        const monitor = fixture(async (url) => {
          const request = new URL(url);
          const inRegion = request.hostname.startsWith(`${residency}.`);
          const filtered =
            missing === "host" || request.searchParams.get("zdr") === "true";
          return catalog(inRegion && filtered ? [] : [MODEL]);
        });
        await monitor.refresh();
        expect(monitor.check(MODEL, residency).isErr()).toBe(true);
        for (const other of MANAGED_AI_RESIDENCIES.filter(
          (value) => value !== residency,
        )) {
          expect(monitor.check(MODEL, other).isOk()).toBe(true);
        }
      });
    }
    for (const fault of [
      "network",
      "timeout",
      "http",
      "json",
      "schema",
    ] as const) {
      test(`invalidates prior availability on ${residency} ${fault} failure and exposes its cause`, async () => {
        let failing = false;
        let aborted = false;
        const cause = new TypeError("fixture network failure");
        const monitor = fixture(async (url, init) => {
          if (!failing || !new URL(url).hostname.startsWith(`${residency}.`)) {
            return catalog([MODEL]);
          }
          switch (fault) {
            case "network":
              throw cause;
            case "timeout":
              init.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                },
                { once: true },
              );
              return await new Promise<Response>(() => {});
            case "http":
              return new Response("fixture response", { status: 503 });
            case "json":
              return new Response("invalid json");
            case "schema":
              return Response.json({ data: [{ name: MODEL }] });
            default:
              fault satisfies never;
          }
        });
        await monitor.refresh();
        expect(monitor.check(MODEL, residency).isOk()).toBe(true);
        failing = true;
        const refreshing = monitor.refresh();
        expect(monitor.check(MODEL, residency).isErr()).toBe(true);
        const outcomes = await refreshing;
        expect(outcomes.filter((result) => result.isErr())).toHaveLength(1);
        const result = monitor.check(MODEL, residency);
        expect(result.isErr()).toBe(true);
        if (Result.isError(result)) {
          expect(result.error.code).toBe(MANAGED_PROVIDER_UNAVAILABLE_CODE);
          expect(result.error.cause).toBeInstanceOf(ManagedProviderCheckError);
          if (result.error.cause instanceof ManagedProviderCheckError) {
            if (fault === "network") {
              expect(result.error.cause.cause).toBe(cause);
            }
            if (fault === "timeout") {
              expect(result.error.cause.cause).toBeInstanceOf(TimeoutError);
              expect(aborted).toBe(true);
            }
          }
        }
        failing = false;
        await monitor.refresh();
        expect(monitor.check(MODEL, residency).isOk()).toBe(true);
      });
    }
  }
});
