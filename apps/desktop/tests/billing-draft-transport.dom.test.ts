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
          "save",
          "save-failed",
          "respond",
          "respond-newest",
          "restart",
          "refresh",
          "draft",
          "redraft",
          "steer",
          "refine",
        ),
        { minLength: 1, maxLength: 80 },
      ),
      async (events) => {
        localStorage.clear();
        let consent = new BillingDraftConsent();
        consent.configure("transport-model");
        let server: "granted" | "revoked" = "revoked";
        let revision = 0;
        let owner = 0;
        let intent: {
          value: "granted" | "revoked";
          generation: number;
          revision: number;
          owner: number;
        } | null = null;
        const responses: {
          value: "granted" | "revoked";
          generation: number;
          owner: number;
          accepted: boolean;
        }[] = [];
        let invokes = 0;
        mockIPC((command) => {
          expect(command).toBe("billing_draft_create_confirmed");
          expect(server).toBe("granted");
          expect(consent.getSnapshot()).toBe("granted");
          expect(
            localStorage.getItem("billing-draft-withdrawal:transport-model"),
          ).toBeNull();
          invokes += 1;
          return {};
        });
        const sequence = [
          "grant",
          "save",
          "withdraw",
          "save-failed",
          "restart",
          "draft",
          "save",
          "respond-newest",
          "respond",
          ...events,
        ] as const;
        for (const event of sequence) {
          switch (event) {
            case "grant":
            case "withdraw": {
              const value = event === "grant" ? "granted" : "revoked";
              intent = {
                value,
                generation: consent.begin(value),
                revision,
                owner,
              };
              break;
            }
            case "save-failed":
              break; // A failed transport cannot confirm or clear local intent.
            case "save": {
              if (intent === null) {
                break;
              }
              const accepted = intent.revision === revision;
              if (accepted) {
                server = intent.value;
                revision += 1;
              }
              responses.push({ ...intent, accepted });
              break;
            }
            case "respond":
            case "respond-newest": {
              const response =
                event === "respond" ? responses.shift() : responses.pop();
              if (response?.accepted && response.owner === owner) {
                consent.confirm(response.value, response.generation);
              }
              break;
            }
            case "restart": {
              const withdrawal = localStorage.getItem(
                "billing-draft-withdrawal:transport-model",
              );
              consent.invalidate();
              consent = new BillingDraftConsent();
              consent.configure("transport-model");
              owner += 1;
              intent = null;
              if (withdrawal !== null) {
                expect(consent.getSnapshot()).toBe("pending-withdrawal");
                intent = {
                  value: "revoked",
                  generation: consent.begin("revoked"),
                  revision,
                  owner,
                };
              } else {
                consent.refresh(server);
              }
              break;
            }
            case "refresh": {
              consent.refresh(server);
              if (intent !== null) {
                intent.revision = revision;
              }
              break;
            }
            case "draft":
            case "redraft":
            case "steer":
            case "refine": {
              const count = invokes;
              const status = consent.getSnapshot();
              const result = await consent.request(
                event === "steer" || event === "refine"
                  ? { ...request, steer: "Adjust" }
                  : request,
              );
              expect(result.type).toBe(
                status === "granted" ? "completed" : "blocked",
              );
              expect(invokes).toBe(count + (status === "granted" ? 1 : 0));
              break;
            }
            default:
              event satisfies never;
          }
          if (
            localStorage.getItem("billing-draft-withdrawal:transport-model") !==
            null
          ) {
            expect(consent.getSnapshot()).not.toBe("granted");
          }
        }
        clearMocks();
        localStorage.clear();
      },
    ),
  );
});
