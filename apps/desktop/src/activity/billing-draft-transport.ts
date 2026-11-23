import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";

import type { DesktopBillingDraftRequest } from "@stll/api-contract/desktop-billing-drafts";

import { draftFailureKind } from "./billing-draft-logic";

/**
 * Consent as this window knows it. A grant counts only once the server
 * confirms it; one it refused, or never answered, leaves `grant-refused`, which
 * the next read replaces and a retry starts again. A withdrawal counts at
 * once and stays until the server confirms it: `pending-withdrawal` while it
 * is sent, `withdrawal-unconfirmed` once a send failed or a restart found it
 * unsent; only a confirmed withdrawal or a new grant ends it.
 */
export type DraftConsentState =
  | { status: "unavailable" }
  | { status: "revoked" }
  | { status: "granted" }
  | { status: "pending-grant" }
  | { status: "grant-refused" }
  | { status: "pending-withdrawal" }
  | { status: "withdrawal-unconfirmed" };
export type DraftConsentStatus = DraftConsentState["status"];
const WITHDRAWAL_KEY = "billing-draft-withdrawal:";
const CONSENT_PROOF = Symbol("current drafting consent");
const BLOCKED = Symbol("drafting blocked");
type CurrentDraftConsent = {
  readonly [CONSENT_PROOF]: true;
  readonly current: () => boolean;
};

/** The only drafting invoke; its proof is rechecked in the same synchronous call. */
const sendDraft = async (
  proof: CurrentDraftConsent,
  request: DesktopBillingDraftRequest,
) => {
  const response = await Result.tryPromise({
    try: async () => {
      if (!proof.current()) {
        return BLOCKED;
      }
      return await invoke<unknown>("billing_draft_create_confirmed", {
        request,
      });
    },
    catch: draftFailureKind,
  });
  if (!proof.current()) {
    return { type: "discarded" } as const;
  }
  if (Result.isOk(response) && response.value === BLOCKED) {
    return { type: "blocked" } as const;
  }
  return { type: "completed", response } as const;
};

/** One consent owner: local intent remains pending until the server confirms it. */
export class BillingDraftConsent {
  #state: DraftConsentState;
  #generation = 0;
  #queue = Promise.resolve(true);
  #scopeKey: string | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(status: "unavailable" | "revoked" | "granted" = "unavailable") {
    this.#state = { status };
  }
  readonly getSnapshot = () => this.#state.status;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #change(state: DraftConsentState) {
    this.#state = state;
    this.#generation += 1;
    for (const listener of this.#listeners) {
      listener();
    }
  }
  #withdrawalStored() {
    return (
      this.#scopeKey !== null &&
      localStorage.getItem(WITHDRAWAL_KEY + this.#scopeKey) !== null
    );
  }
  configure(scopeKey: string) {
    if (scopeKey === this.#scopeKey) {
      return;
    }
    const pending = localStorage.getItem(WITHDRAWAL_KEY + scopeKey);
    this.#scopeKey = scopeKey;
    this.#change(
      pending === null
        ? { status: "unavailable" }
        : { status: "withdrawal-unconfirmed" },
    );
  }
  captureScope() {
    return this.#scopeKey;
  }
  ownsScope(scopeKey: string) {
    return scopeKey === this.#scopeKey;
  }
  async enqueue(scopeKey: string, save: () => Promise<boolean>) {
    const pending = this.#queue.then(async () =>
      this.ownsScope(scopeKey) ? await save() : false,
    );
    this.#queue = pending;
    return await pending;
  }
  refresh(status: "unavailable" | "revoked" | "granted") {
    switch (this.#state.status) {
      case "pending-grant":
      case "pending-withdrawal":
      case "withdrawal-unconfirmed":
        return;
      case "unavailable":
      case "revoked":
      case "granted":
      case "grant-refused":
        this.#change({ status });
        return;
      default:
        this.#state satisfies never;
        panic("Unknown billing draft consent state");
    }
  }
  begin(value: "granted" | "revoked") {
    // Persist before any await or network call. Keep the marker through an unconfirmed re-grant.
    this.#change(
      value === "granted"
        ? { status: "pending-grant" }
        : { status: "pending-withdrawal" },
    );
    if (value === "revoked" && this.#scopeKey !== null) {
      localStorage.setItem(WITHDRAWAL_KEY + this.#scopeKey, "pending");
    }
    return this.#generation;
  }
  isCurrent(generation: number) {
    return generation === this.#generation;
  }
  confirm(value: "granted" | "revoked", generation: number) {
    if (
      !this.isCurrent(generation) ||
      this.#state.status !==
        (value === "granted" ? "pending-grant" : "pending-withdrawal")
    ) {
      return false;
    }
    if (this.#scopeKey !== null) {
      localStorage.removeItem(WITHDRAWAL_KEY + this.#scopeKey);
    }
    this.#change({ status: value });
    return true;
  }
  /** Settles the save begun at `generation` when the server did not confirm
   * it; a later save or account change has already moved on. */
  fail(generation: number) {
    if (this.isCurrent(generation)) {
      this.#settleUnconfirmed();
    }
  }
  /** No answer will confirm the save on its way, so the choice can be made
   * again: a grant stops counting as on its way, and a withdrawal stays in
   * force, unconfirmed, also under a re-grant that did not go through. */
  #settleUnconfirmed() {
    switch (this.#state.status) {
      case "pending-grant":
        this.#change(
          this.#withdrawalStored()
            ? { status: "withdrawal-unconfirmed" }
            : { status: "grant-refused" },
        );
        return;
      case "pending-withdrawal":
        this.#change({ status: "withdrawal-unconfirmed" });
        return;
      case "unavailable":
      case "revoked":
      case "granted":
      case "grant-refused":
      case "withdrawal-unconfirmed":
        return;
      default:
        this.#state satisfies never;
        panic("Unknown billing draft consent state");
    }
  }
  invalidate() {
    // Cancel in-flight proofs and acknowledgements without losing durable local intent.
    this.#generation += 1;
    this.#settleUnconfirmed();
    this.refresh("unavailable");
  }
  async request(request: DesktopBillingDraftRequest) {
    if (this.#state.status !== "granted") {
      return { type: "blocked" } as const;
    }
    const generation = this.#generation;
    const proof = {
      [CONSENT_PROOF]: true,
      current: () =>
        this.#state.status === "granted" && generation === this.#generation,
    } as const satisfies CurrentDraftConsent;
    return await sendDraft(proof, request);
  }
}
