import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";

import type { DesktopBillingDraftRequest } from "@stll/api-contract/desktop-billing-drafts";

import { draftFailureMessage } from "./billing-draft-logic";

export type DraftConsentState =
  | { status: "unavailable" }
  | { status: "revoked" }
  | { status: "granted" }
  | { status: "pending-grant" }
  | { status: "pending-withdrawal" };
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
    catch: draftFailureMessage,
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
  configure(scopeKey: string) {
    if (scopeKey === this.#scopeKey) {
      return;
    }
    const pending = localStorage.getItem(WITHDRAWAL_KEY + scopeKey);
    this.#scopeKey = scopeKey;
    this.#change(
      pending === null
        ? { status: "unavailable" }
        : { status: "pending-withdrawal" },
    );
  }
  refresh(status: "unavailable" | "revoked" | "granted") {
    switch (this.#state.status) {
      case "pending-grant":
      case "pending-withdrawal":
        return;
      case "unavailable":
      case "revoked":
      case "granted":
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
  invalidate() {
    // Cancel in-flight proofs and acknowledgements without losing durable local intent.
    this.#generation += 1;
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
