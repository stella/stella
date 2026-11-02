import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";

import type { DesktopBillingDraftEffectiveMode } from "@stll/api-contract/desktop-billing-drafts";

import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import { scopedDraftSettingsFrom } from "./billing-draft-logic";
import { BillingDraftConsent } from "./billing-draft-transport";
import type { DraftConsentStatus } from "./billing-draft-transport";

type BillingDraftSettings =
  | { type: "loading" }
  | { type: "unavailable" }
  | { type: "failed" }
  | {
      type: "ready";
      /** What the organization lets this user draft: nothing, plain
       * descriptions, or guided drafts with codes and flags. */
      mode: DesktopBillingDraftEffectiveMode;
      consent: DraftConsentStatus;
      preference: string | null;
    };

export type BillingDraftSettingsControl = {
  settings: BillingDraftSettings;
  consent: BillingDraftConsent;
  reload: () => void;
  setConsent: (consent: "granted" | "revoked") => Promise<boolean>;
};

// Fixed codes only: nothing about the drafts leaves the window.
const reportFailure = (
  operation: (typeof DESKTOP_TELEMETRY_OPERATIONS)[
    "activityRead" | "activityUpdate"],
  code: (typeof DESKTOP_TELEMETRY_ERROR_CODES)[
    "invalidResponse" | "invokeFailed"],
) => {
  reportDesktopError({
    code,
    operation,
    window: DESKTOP_TELEMETRY_WINDOWS.activity,
  });
};

type Loaded =
  | { type: "loading" }
  | { type: "failed" }
  | {
      type: "ready";
      mode: DesktopBillingDraftEffectiveMode;
      preference: string | null;
    };

/**
 * The caller's AI drafting settings and their one consent owner. A withdrawal
 * takes effect in the window at once and is kept until the server confirms
 * it; a grant counts only once the server confirms it. Saves run one at a
 * time and only for the account they began on.
 */
export const useBillingDraftSettings = (
  enabled: boolean,
): BillingDraftSettingsControl => {
  const [loaded, setLoaded] = useState<Loaded>({ type: "loading" });
  const [consent] = useState(() => new BillingDraftConsent());
  const consentStatus = useSyncExternalStore(
    consent.subscribe,
    consent.getSnapshot,
  );
  const request = useRef(0);
  const settings: BillingDraftSettings = (() => {
    if (!enabled) {
      return { type: "unavailable" };
    }
    if (loaded.type !== "ready") {
      return loaded;
    }
    return {
      type: "ready",
      mode: loaded.mode,
      consent: consentStatus,
      preference: loaded.preference,
    };
  })();
  useLayoutEffect(() => {
    if (!enabled) {
      consent.invalidate();
    }
  }, [enabled, consent]);

  const setConsent = useCallback(
    async (value: "granted" | "revoked") => {
      const scopeKey = consent.captureScope();
      if (scopeKey === null) {
        return false;
      }
      const intent = Result.try(() => consent.begin(value));
      if (intent.isErr()) {
        reportFailure(
          DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
          DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        );
        return false;
      }
      const generation = intent.value;
      const save = async () => {
        const result = await Result.tryPromise(async () => {
          let answer: unknown;
          if (value === "granted") {
            // The grant is compare-and-set: read the current revision first,
            // even after a lost answer.
            const current = scopedDraftSettingsFrom(
              await invoke<unknown>("billing_draft_get_settings"),
            );
            if (
              current === null ||
              current.scopeKey !== scopeKey ||
              !consent.ownsScope(scopeKey) ||
              !consent.isCurrent(generation)
            ) {
              return false;
            }
            answer = await invoke<unknown>("billing_draft_grant_consent", {
              scopeKey,
              revision: current.settings.revision,
            });
          } else {
            answer = await invoke<unknown>("billing_draft_withdraw_consent", {
              scopeKey,
            });
          }
          const next = scopedDraftSettingsFrom(answer);
          if (
            next === null ||
            next.scopeKey !== scopeKey ||
            !consent.ownsScope(scopeKey) ||
            next.settings.consent !== value ||
            !consent.isCurrent(generation)
          ) {
            return false;
          }
          if (!consent.confirm(next.settings.consent, generation)) {
            return false;
          }
          setLoaded({
            type: "ready",
            mode: next.settings.effectiveMode,
            preference: next.settings.preference,
          });
          return true;
        });
        if (result.isErr() || !result.value) {
          reportFailure(
            DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
            DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          );
          return false;
        }
        return true;
      };
      return await consent.enqueue(scopeKey, save);
    },
    [consent],
  );

  const reload = useCallback(() => {
    const current = ++request.current;
    consent.invalidate();
    if (!enabled) {
      return;
    }
    void Result.tryPromise(async () => {
      const next = scopedDraftSettingsFrom(
        await invoke<unknown>("billing_draft_get_settings"),
      );
      if (current !== request.current) {
        return;
      }
      if (next === null) {
        reportFailure(
          DESKTOP_TELEMETRY_OPERATIONS.activityRead,
          DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
        );
        consent.refresh("unavailable");
        setLoaded({ type: "failed" });
        return;
      }
      consent.configure(next.scopeKey);
      setLoaded({
        type: "ready",
        mode: next.settings.effectiveMode,
        preference: next.settings.preference,
      });
      // A withdrawal the server never confirmed is sent again first.
      if (consent.getSnapshot() === "pending-withdrawal") {
        await setConsent("revoked");
        return;
      }
      consent.refresh(next.settings.consent);
    }).then((result) => {
      if (result.isErr() && current === request.current) {
        reportFailure(
          DESKTOP_TELEMETRY_OPERATIONS.activityRead,
          DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        );
        consent.refresh("unavailable");
        setLoaded({ type: "failed" });
      }
      return undefined;
    });
  }, [enabled, consent, setConsent]);

  useEffect(() => {
    reload();
    return () => {
      request.current += 1;
      consent.invalidate();
    };
  }, [reload, consent]);

  return { settings, consent, reload, setConsent };
};
