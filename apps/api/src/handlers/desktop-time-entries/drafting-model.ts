import { Result } from "better-result";
import type * as v from "valibot";

import type { DesktopBillingDraftMode } from "@stll/api-contract/desktop-billing-drafts";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { DispatchCheck } from "@/api/lib/tanstack-ai-generate";
import {
  generateTanStackObjectForTask,
  generateTanStackTextForTask,
} from "@/api/lib/tanstack-ai-generate";

import {
  billingDraftDispatchRefusal,
  type BillingDraftGate,
  billingDraftGateRefusal,
  loadBillingDraftGate,
} from "./billing-draft-mode";

// The only way this directory reaches a model. Every request a desktop time
// entry sends carries privileged activity (window titles, documents, time
// history), so it needs the organization's switch on and the member's own
// consent, read for this request and again right before every provider
// request the call makes: a retry, a repair or a fallback model included.
// `scripts/ownership/model-request-send-mode.ts` lists this file as the
// directory's one model caller.

type DraftingAccount = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type AdmitDraftingOptions = DraftingAccount & {
  /** Test seam for the gate read; production reads the database. */
  loadGate?: typeof loadBillingDraftGate | undefined;
};

/**
 * Proof that the organization allows AI drafting and the caller consents,
 * read for this request. Only {@link DraftingAdmission.admit} makes one, and
 * the model calls below take nothing else.
 */
export class DraftingAdmission {
  private readonly account: DraftingAccount;
  private readonly loadGate: typeof loadBillingDraftGate;
  /** The gate as read when the request was admitted. */
  readonly gate: BillingDraftGate;

  private constructor(
    account: DraftingAccount,
    loadGate: typeof loadBillingDraftGate,
    gate: BillingDraftGate,
  ) {
    this.account = account;
    this.loadGate = loadGate;
    this.gate = gate;
  }

  /** Reads the gate and refuses before any context or model work. */
  static async admit({
    loadGate = loadBillingDraftGate,
    ...account
  }: AdmitDraftingOptions): Promise<
    Result<DraftingAdmission, HandlerError | SafeDbError>
  > {
    const gate = await loadGate(account);
    if (gate.isErr()) {
      return Result.err(gate.error);
    }
    const refusal = billingDraftGateRefusal(gate.value);
    if (refusal) {
      return Result.err(refusal);
    }
    return Result.ok(new DraftingAdmission(account, loadGate, gate.value));
  }

  /**
   * Reads the gate again: the switch, the consent and, with `expectedMode`,
   * whether the firm guideline binding still gives that drafting mode.
   */
  async recheck(
    expectedMode: DesktopBillingDraftMode | undefined,
  ): Promise<Result<void, HandlerError | SafeDbError>> {
    const gate = await this.loadGate(this.account);
    if (gate.isErr()) {
      return Result.err(gate.error);
    }
    const refusal = billingDraftDispatchRefusal(gate.value, expectedMode);
    return refusal ? Result.err(refusal) : Result.ok(undefined);
  }
}

/** Why a gated model call returned no answer. */
export type GatedGenerationFailure =
  /** The gate refused right before a provider request; nothing was sent. */
  | { type: "refused"; error: HandlerError | SafeDbError }
  /** The generation itself failed. */
  | { type: "failed"; cause: unknown };

/** The model calls a test may stand in for. */
export type ObjectGeneration = typeof generateTanStackObjectForTask;
export type TextGeneration = typeof generateTanStackTextForTask;

const generateGated = async <T>(
  admission: DraftingAdmission,
  expectedMode: DesktopBillingDraftMode | undefined,
  run: (beforeEachDispatch: DispatchCheck) => Promise<T>,
): Promise<Result<T, GatedGenerationFailure>> => {
  // Set from the dispatch check, which control-flow analysis cannot see; the
  // generation may wrap the refusal it stops on, so it is kept here.
  const dispatch: { refusal: HandlerError | SafeDbError | undefined } = {
    refusal: undefined,
  };
  const generated = await Result.tryPromise({
    try: async () =>
      await run(async () => {
        const current = await admission.recheck(expectedMode);
        if (current.isErr()) {
          dispatch.refusal = current.error;
        }
        return current;
      }),
    catch: (cause: unknown) => cause,
  });
  if (dispatch.refusal !== undefined) {
    return Result.err({ type: "refused", error: dispatch.refusal });
  }
  if (generated.isErr()) {
    return Result.err({ type: "failed", cause: generated.error });
  }
  return Result.ok(generated.value);
};

type GenerateAdmittedObjectOptions<TSchema extends v.GenericSchema> = {
  admission: DraftingAdmission;
  /** The drafting mode the prompt was built for; a change refuses with 409. */
  expectedMode: DesktopBillingDraftMode;
  /** The generation; its own `beforeEachDispatch` is replaced by the gate. */
  request: Parameters<typeof generateTanStackObjectForTask<TSchema>>[0];
  generate?: ObjectGeneration | undefined;
};

/** A structured generation that re-reads the gate before every request. */
export const generateAdmittedObject = async <TSchema extends v.GenericSchema>({
  admission,
  expectedMode,
  request,
  generate = generateTanStackObjectForTask,
}: GenerateAdmittedObjectOptions<TSchema>) =>
  await generateGated(
    admission,
    expectedMode,
    async (beforeEachDispatch) =>
      await generate({ ...request, beforeEachDispatch }),
  );

type GenerateAdmittedTextOptions = {
  admission: DraftingAdmission;
  /** The generation; its own `beforeEachDispatch` is replaced by the gate. */
  request: Parameters<typeof generateTanStackTextForTask>[0];
  generate?: TextGeneration | undefined;
};

/** A text generation that re-reads the gate before every request. */
export const generateAdmittedText = async ({
  admission,
  request,
  generate = generateTanStackTextForTask,
}: GenerateAdmittedTextOptions) =>
  await generateGated(
    admission,
    undefined,
    async (beforeEachDispatch) =>
      await generate({ ...request, beforeEachDispatch }),
  );
