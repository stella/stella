import { panic, Result } from "better-result";
import { Glob } from "bun";
import { expect, test } from "bun:test";

import { DESKTOP_BILLING_DRAFT_REFUSAL_CODE } from "@stll/api-contract/desktop-billing-drafts";

import { toSafeId } from "@/api/lib/branded-types";
import type {
  DispatchCheck,
  generateTanStackObjectForTask,
  generateTanStackTextForTask,
} from "@/api/lib/tanstack-ai-generate";
import { runDispatchCheck } from "@/api/tests/helpers/dispatch-check";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { BillingDraftGate } from "./billing-draft-mode";
import {
  DraftingAdmission,
  generateAdmittedObject,
  generateAdmittedText,
} from "./drafting-model";

const consenting: BillingDraftGate = {
  organizationMode: "enabled",
  consentAt: new Date("2026-10-01T12:00:00Z"),
  preference: null,
  draftingMode: "plain",
};

/** An admission whose gate reads answer `gates` in turn, the last repeating. */
const admitWith = async (gates: readonly BillingDraftGate[]) => {
  let reads = 0;
  const admission = await DraftingAdmission.admit({
    safeDb: async () => await Promise.resolve(panic("No database is read")),
    organizationId: toSafeId<"organization">("org_drafting_gate"),
    userId: toSafeId<"user">("user_drafting_gate"),
    loadGate: async () => {
      const gate = gates.at(Math.min(reads, gates.length - 1)) ?? consenting;
      reads += 1;
      return await Promise.resolve(Result.ok(gate));
    },
  });
  return { admission, reads: () => reads };
};

type TextRequest = Parameters<typeof generateTanStackTextForTask>[0];
const textRequest = asTestRaw<TextRequest>({
  finishPolicy: "require-complete",
});

test("the directory reaches a model only through the gated module", async () => {
  const modelImport =
    /^import\s+(?!type\b)[^;]*?from\s+"@\/api\/lib\/(?:tanstack-ai-generate|chat\/tanstack-chat-runtime)"/mu;
  const callers: string[] = [];
  for (const file of new Glob("**/*.ts").scanSync(import.meta.dir)) {
    if (file.endsWith(".test.ts")) {
      continue;
    }
    const source = await Bun.file(`${import.meta.dir}/${file}`).text();
    if (modelImport.test(source)) {
      callers.push(file);
    }
  }
  expect(callers).toEqual(["drafting-model.ts"]);
});

test("an organization switched off or a missing consent admits nothing", async () => {
  for (const [gate, code] of [
    [
      { ...consenting, organizationMode: "disabled" },
      DESKTOP_BILLING_DRAFT_REFUSAL_CODE.organizationOff,
    ],
    [
      { ...consenting, consentAt: null },
      DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired,
    ],
  ] as const) {
    const { admission } = await admitWith([gate]);
    expect(admission.isErr()).toBe(true);
    if (admission.isErr()) {
      expect(admission.error).toMatchObject({ status: 403, code });
    }
  }
});

test("every provider request reads the gate again, retries and fallbacks included", async () => {
  const withdrawn = { ...consenting, consentAt: null };
  const { admission, reads } = await admitWith([
    consenting,
    consenting,
    consenting,
    withdrawn,
  ]);
  let sent = 0;
  const generated = await generateAdmittedText({
    admission: admission.unwrap(),
    request: textRequest,
    // A first request, a retry after a provider delay, then a fallback model
    // the member no longer consents to; the generation wraps what it sees.
    generate: async ({ beforeEachDispatch }) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const checked = await Result.tryPromise({
          try: async () => await runDispatchCheck(beforeEachDispatch),
          catch: () => new Error("Generation failed"),
        });
        if (checked.isErr()) {
          throw checked.error;
        }
        sent += 1;
      }
      return "never returned";
    },
  });
  expect(sent).toBe(2);
  expect(reads()).toBe(4);
  expect(generated.isErr()).toBe(true);
  if (generated.isErr()) {
    expect(generated.error).toMatchObject({
      type: "refused",
      error: {
        status: 403,
        code: DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired,
      },
    });
  }
});

test("a firm guideline binding that changes before a request refuses with 409", async () => {
  const { admission } = await admitWith([
    consenting,
    { ...consenting, draftingMode: "guided" },
  ]);
  let sent = 0;
  const generated = await generateAdmittedObject({
    admission: admission.unwrap(),
    expectedMode: "plain",
    request: asTestRaw<Parameters<typeof generateAdmittedObject>[0]["request"]>(
      {},
    ),
    generate: asTestRaw<typeof generateTanStackObjectForTask>(
      async ({
        beforeEachDispatch,
      }: {
        beforeEachDispatch?: DispatchCheck;
      }) => {
        await runDispatchCheck(beforeEachDispatch);
        sent += 1;
        return await Promise.resolve({});
      },
    ),
  });
  expect(sent).toBe(0);
  expect(generated.isErr()).toBe(true);
  if (generated.isErr()) {
    expect(generated.error).toMatchObject({
      type: "refused",
      error: {
        status: 409,
        code: DESKTOP_BILLING_DRAFT_REFUSAL_CODE.modeChanged,
      },
    });
  }
});

test("a generation failure is the model's, not the gate's", async () => {
  const { admission } = await admitWith([consenting]);
  const cause = new Error("Provider unavailable");
  const generated = await generateAdmittedText({
    admission: admission.unwrap(),
    request: textRequest,
    generate: async ({ beforeEachDispatch }) => {
      await runDispatchCheck(beforeEachDispatch);
      throw cause;
    },
  });
  expect(generated.isErr()).toBe(true);
  if (generated.isErr()) {
    expect(generated.error).toEqual({ type: "failed", cause });
  }
});
