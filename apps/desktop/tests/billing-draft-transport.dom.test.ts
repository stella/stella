import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import requestFixture from "../fixtures/billing-draft-request.json";

GlobalRegistrator.register({ url: "http://localhost/" });
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { BillingDraftConsent } =
  await import("../src/activity/billing-draft-transport");
const request =
  requestFixture.requests.at(0) ?? panic("Missing drafting request fixture");

afterEach(clearMocks);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("the drafting invoke has exactly one consent-gated transport owner", () => {
  const directory = path.resolve(import.meta.dirname, "../src");
  const sites: { file: string; count: number }[] = [];
  for (const file of new Bun.Glob("**/*.{ts,tsx,js,jsx}").scanSync(directory)) {
    const source = readFileSync(path.join(directory, file), "utf-8");
    const count = [...source.matchAll(/billing_draft_create_confirmed/gu)]
      .length;
    if (count > 0) {
      sites.push({ file, count });
    }
  }
  expect(sites).toEqual([
    { file: "activity/billing-draft-transport.ts", count: 1 },
  ]);
});

test("billing-draft.current-consent-gates-every-random-transport-action", async () => {
  await assertProperty(
    "billing-draft.current-consent-gates-every-random-transport-action",
    fc.asyncProperty(
      fc.array(
        fc.constantFrom(
          "grant",
          "withdraw",
          "refresh-granted",
          "unavailable",
          "draft",
          "redraft",
          "steer",
          "refine",
          "resolve",
        ),
        { minLength: 1, maxLength: 60 },
      ),
      async (events) => {
        const consent = new BillingDraftConsent();
        let status: "unavailable" | "revoked" | "granted" = "unavailable";
        let policy: "settings" | "withdrawn" = "settings";
        let epoch = 0;
        const invoked: ReturnType<typeof Promise.withResolvers<unknown>>[] = [];
        const pending: {
          promise: ReturnType<typeof consent.request>;
          epoch: number;
          deferred: ReturnType<typeof Promise.withResolvers<unknown>>;
        }[] = [];
        mockIPC(async (command) => {
          if (command !== "billing_draft_create_confirmed") {
            return panic("Unexpected transport command", command);
          }
          expect(status).toBe("granted");
          expect(consent.getSnapshot()).toBe("granted");
          const deferred = Promise.withResolvers<unknown>();
          invoked.push(deferred);
          return await deferred.promise;
        });
        const changeStatus = (next: typeof status) => {
          if (next !== status) {
            epoch += 1;
          }
          return next;
        };
        const complete = async () => {
          const call = pending.shift();
          if (call === undefined) {
            return;
          }
          call.deferred.resolve({ result: "permitted response" });
          expect((await call.promise).type).toBe(
            call.epoch === epoch ? "completed" : "discarded",
          );
        };
        // Exercise every route after withdrawal and an in-flight withdrawal/re-grant in every sample.
        const sequence = [
          "grant",
          "draft",
          "withdraw",
          "steer",
          "refine",
          "redraft",
          "refresh-granted",
          "draft",
          "grant",
          "resolve",
          ...events,
        ] as const;
        for (const event of sequence) {
          switch (event) {
            case "grant":
              policy = "settings";
              status = changeStatus("granted");
              consent.grant();
              break;
            case "withdraw":
              policy = "withdrawn";
              status = changeStatus("revoked");
              consent.withdraw();
              break;
            case "refresh-granted":
              status = changeStatus(
                policy === "withdrawn" ? "revoked" : "granted",
              );
              consent.refresh("granted");
              break;
            case "unavailable":
              status = changeStatus("unavailable");
              consent.refresh("unavailable");
              break;
            case "resolve":
              await complete();
              break;
            case "draft":
            case "redraft":
            case "steer":
            case "refine": {
              const count = invoked.length;
              const promise = consent.request(
                event === "steer" || event === "refine"
                  ? { ...request, steer: "Adjust" }
                  : request,
              );
              await Promise.resolve();
              if (status !== "granted") {
                expect((await promise).type).toBe("blocked");
                expect(invoked).toHaveLength(count);
              } else {
                expect(invoked).toHaveLength(count + 1);
                pending.push({
                  promise,
                  epoch,
                  deferred:
                    invoked.at(-1) ?? panic("Missing permitted invocation"),
                });
              }
              break;
            }
            default:
              event satisfies never;
          }
          expect(consent.getSnapshot()).toBe(status);
        }
        while (pending.length > 0) {
          await complete();
        }
        clearMocks();
      },
    ),
  );
});
