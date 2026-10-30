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
          "switch-account",
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
        let scopeKey = "transport-model-a";
        consent.configure(scopeKey);
        const accounts = new Map<
          string,
          { consent: "granted" | "revoked"; revision: number }
        >([
          ["transport-model-a", { consent: "revoked", revision: 0 }],
          ["transport-model-b", { consent: "revoked", revision: 0 }],
        ]);
        const currentAccount = () =>
          accounts.get(scopeKey) ?? panic("Missing model account");
        let owner = 0;
        let intent: {
          value: "granted" | "revoked";
          generation: number;
          revision: number;
          owner: number;
          scopeKey: string;
        } | null = null;
        const responses: {
          value: "granted" | "revoked";
          generation: number;
          owner: number;
          scopeKey: string;
          accepted: boolean;
        }[] = [];
        let invokes = 0;
        mockIPC((command) => {
          expect(command).toBe("billing_draft_create_confirmed");
          expect(currentAccount().consent).toBe("granted");
          expect(consent.getSnapshot()).toBe("granted");
          expect(
            localStorage.getItem(`billing-draft-withdrawal:${scopeKey}`),
          ).toBeNull();
          invokes += 1;
          return {};
        });
        const saveIntent = async (queued: NonNullable<typeof intent>) =>
          await consent.enqueue(queued.scopeKey, async () => {
            expect(scopeKey).toBe(queued.scopeKey);
            const account = currentAccount();
            const accepted = queued.revision === account.revision;
            if (accepted) {
              account.consent = queued.value;
              account.revision += 1;
            }
            responses.push({ ...queued, accepted });
            return accepted;
          });

        const sequence = [
          "grant",
          "save",
          "withdraw",
          "save-failed",
          "switch-account",
          "save",
          "switch-account",
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
                revision: currentAccount().revision,
                owner,
                scopeKey,
              };
              break;
            }
            case "save-failed":
              break; // A failed transport cannot confirm or clear local intent.
            case "save": {
              if (intent === null) {
                break;
              }
              await saveIntent(intent);
              break;
            }
            case "respond":
            case "respond-newest": {
              const response =
                event === "respond" ? responses.shift() : responses.pop();
              if (
                response?.accepted &&
                response.owner === owner &&
                consent.ownsScope(response.scopeKey)
              ) {
                consent.confirm(response.value, response.generation);
              }
              break;
            }
            case "restart": {
              const withdrawal = localStorage.getItem(
                `billing-draft-withdrawal:${scopeKey}`,
              );
              consent.invalidate();
              consent = new BillingDraftConsent();
              consent.configure(scopeKey);
              owner += 1;
              intent = null;
              if (withdrawal !== null) {
                expect(consent.getSnapshot()).toBe("pending-withdrawal");
                intent = {
                  value: "revoked",
                  generation: consent.begin("revoked"),
                  revision: currentAccount().revision,
                  owner,
                  scopeKey,
                };
              } else {
                consent.refresh(currentAccount().consent);
              }
              break;
            }
            case "switch-account": {
              scopeKey =
                scopeKey === "transport-model-a"
                  ? "transport-model-b"
                  : "transport-model-a";
              consent.configure(scopeKey);
              consent.refresh(currentAccount().consent);
              break;
            }
            case "refresh": {
              consent.refresh(currentAccount().consent);
              if (intent !== null && intent.scopeKey === scopeKey) {
                intent.revision = currentAccount().revision;
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
            localStorage.getItem(`billing-draft-withdrawal:${scopeKey}`) !==
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
