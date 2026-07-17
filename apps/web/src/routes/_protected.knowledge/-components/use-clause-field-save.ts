import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import type { ToAPIErrorProps } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";

// Eden response shape the persist call returns; only the error branch is read
// here, so the success payload stays `unknown`.
type ClausePersistResponse =
  | { data: unknown; error: null }
  | { data: null; error: ToAPIErrorProps };

type UseClauseFieldSaveOptions = {
  /** Current persisted value; a save that matches it is skipped. */
  value: string | null;
  /**
   * Persists the normalized value and returns the Eden response. The typed
   * `api.clauses(...).post(...)` call stays at the call site so inference and
   * the per-field payload key stay explicit.
   */
  persist: (next: string | null) => Promise<ClausePersistResponse>;
  onRefresh: () => void;
  /** Optional failure side effect, e.g. reverting the local draft. */
  onError?: () => void;
};

/**
 * Shared autosave sequence for inline clause metadata fields: trim (sending
 * `null` when empty), skip when unchanged, persist, surface a localized error
 * toast (with an optional revert), and refresh on success. Returns the save
 * callback; pass it the raw draft text.
 */
export const useClauseFieldSave = ({
  value,
  persist,
  onRefresh,
  onError,
}: UseClauseFieldSaveOptions) => {
  const t = useTranslations();

  return async (rawText: string) => {
    const next = rawText.trim() || null;
    if (next === (value ?? null)) {
      return;
    }

    const response = await persist(next);
    if (response.error) {
      onError?.();
      stellaToast.add({
        type: "error",
        title: t("clauses.saveFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    onRefresh();
  };
};
