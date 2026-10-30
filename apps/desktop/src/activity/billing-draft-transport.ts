import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";

import type { DesktopBillingDraftRequest } from "@stll/api-contract/desktop-billing-drafts";

import { draftFailureMessage } from "./billing-draft-logic";

export type DraftConsentStatus = "unavailable" | "revoked" | "granted";
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

/** Only a verified explicit grant can undo a local withdrawal, including after failed persistence. */
export class BillingDraftConsent {
  #status: DraftConsentStatus;
  #policy: "settings" | "withdrawn" = "settings";
  #generation = 0;
  readonly #listeners = new Set<() => void>();

  constructor(status: DraftConsentStatus = "unavailable") {
    this.#status = status;
  }
  readonly getSnapshot = () => this.#status;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #change(status: DraftConsentStatus) {
    if (status === this.#status) {
      return;
    }
    this.#status = status;
    this.#generation += 1;
    for (const listener of this.#listeners) {
      listener();
    }
  }
  refresh(status: DraftConsentStatus) {
    this.#change(
      this.#policy === "withdrawn" && status === "granted" ? "revoked" : status,
    );
  }
  withdraw() {
    this.#policy = "withdrawn";
    this.#change("revoked");
  }
  grant() {
    this.#policy = "settings";
    this.#change("granted");
  }
  async request(request: DesktopBillingDraftRequest) {
    if (this.#status !== "granted") {
      return { type: "blocked" } as const;
    }
    const generation = this.#generation;
    const proof = {
      [CONSENT_PROOF]: true,
      current: () =>
        this.#status === "granted" && generation === this.#generation,
    } as const satisfies CurrentDraftConsent;
    return await sendDraft(proof, request);
  }
}
