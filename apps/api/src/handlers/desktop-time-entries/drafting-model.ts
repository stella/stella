import { panic, Result, UnhandledException } from "better-result";
import type * as v from "valibot";

import type { DesktopBillingDraftMode } from "@stll/api-contract/desktop-billing-drafts";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DatabaseError,
  DatabaseRlsError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import type { DispatchCheck } from "@/api/lib/tanstack-ai-generate";
import {
  DispatchRefusedError,
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

type GateReader = typeof loadBillingDraftGate;

type GateFailure = HandlerError | SafeDbError;

// Held only by this module: nothing else can construct an admission.
const ADMISSION = Symbol("DraftingAdmission");

/**
 * Proof that the organization allows AI drafting and the caller consents,
 * read for this request. Only {@link DraftingAdmission.admit} makes one in
 * production, and the model calls below take nothing else.
 */
export class DraftingAdmission {
  private readonly account: DraftingAccount;
  private readonly loadGate: GateReader;
  /** The gate as read when the request was admitted. */
  readonly gate: BillingDraftGate;

  constructor(
    token: typeof ADMISSION,
    account: DraftingAccount,
    loadGate: GateReader,
    gate: BillingDraftGate,
  ) {
    if (token !== ADMISSION) {
      panic("A drafting admission is made only by reading the gate");
    }
    this.account = account;
    this.loadGate = loadGate;
    this.gate = gate;
  }

  /** Reads the gate and refuses before any context or model work. */
  static async admit(
    account: DraftingAccount,
  ): Promise<Result<DraftingAdmission, GateFailure>> {
    return await admitThrough(account, loadBillingDraftGate);
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

const admitThrough = async (
  account: DraftingAccount,
  loadGate: GateReader,
): Promise<Result<DraftingAdmission, GateFailure>> => {
  const gate = await loadGate(account);
  if (gate.isErr()) {
    return Result.err(gate.error);
  }
  const refusal = billingDraftGateRefusal(gate.value);
  if (refusal) {
    return Result.err(refusal);
  }
  return Result.ok(
    new DraftingAdmission(ADMISSION, account, loadGate, gate.value),
  );
};

/**
 * A test's admission, whose gate reads answer from `loadGate` instead of the
 * database. `scripts/ownership/drafting-gate-reader.ts` confines it to tests;
 * production admits only through {@link DraftingAdmission.admit}.
 */
export const admitDraftingWithGateReader = async ({
  loadGate,
  ...account
}: DraftingAccount & { loadGate: GateReader }) =>
  await admitThrough(account, loadGate);

/** How an endpoint admits a request; tests pass a confined gate reader. */
export type AdmitDrafting = (
  account: DraftingAccount,
) => Promise<Result<DraftingAdmission, GateFailure>>;

/** Why a gated model call returned no answer. */
export type GatedGenerationFailure =
  /** The gate refused right before a provider request; nothing was sent. */
  | { type: "refused"; error: GateFailure }
  /** The generation itself failed. */
  | { type: "failed"; cause: unknown };

/** The model calls a test may stand in for. */
export type ObjectGeneration = typeof generateTanStackObjectForTask;
export type TextGeneration = typeof generateTanStackTextForTask;

const isGateFailure = (value: unknown): value is GateFailure =>
  HandlerError.is(value) ||
  DatabaseError.is(value) ||
  DatabaseRlsError.is(value) ||
  UnhandledException.is(value);

const generateGated = async <T>(
  admission: DraftingAdmission,
  expectedMode: DesktopBillingDraftMode | undefined,
  run: (beforeEachDispatch: DispatchCheck) => Promise<T>,
): Promise<Result<T, GatedGenerationFailure>> => {
  const generated = await Result.tryPromise({
    try: async () =>
      await run(async () => await admission.recheck(expectedMode)),
    catch: (cause: unknown) => cause,
  });
  if (generated.isOk()) {
    return Result.ok(generated.value);
  }
  // The generation surfaces the gate's refusal as its own typed error,
  // never as a model failure.
  const cause = generated.error;
  if (cause instanceof DispatchRefusedError) {
    return Result.err({
      type: "refused",
      error: isGateFailure(cause.refusal)
        ? cause.refusal
        : panic("A drafting dispatch check refused with a foreign error"),
    });
  }
  return Result.err({ type: "failed", cause });
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
