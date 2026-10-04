import { hashKey, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";

import { stellaToast } from "@stll/ui/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";

type SuccessToast = { title: string; description?: string };

// When `description` is set the shown text is derived from the thrown error via
// `userErrorFromThrown`, falling back to `description`; when it is omitted the
// toast is title-only.
type ErrorToast = { title: string; description?: string };

type UseSettingsMutationOptions<TVariables, TData> = {
  mutationFn: (variables: TVariables) => Promise<TData>;
  /** Key to invalidate once the mutation resolves. */
  invalidate: QueryKey;
  /**
   * Whether to invalidate on success only (default) or on settle. Use
   * `"settled"` for optimistic reorders that must refetch even after an error.
   */
  invalidateOn?: "success" | "settled";
  successToast?: SuccessToast;
  errorToast?: ErrorToast;
  /** Extra success side effect, e.g. clearing an input. */
  onSuccess?: (data: TData, variables: TVariables) => void;
  /** Extra error side effect, e.g. reverting an optimistic draft. */
  onError?: (error: unknown, variables: TVariables) => void;
};

/** Scope id shared by every settings write that invalidates `key`. */
const settingsMutationScopeId = (key: QueryKey): string =>
  `settings:${hashKey(key)}`;

/**
 * Shared plumbing for organization-settings mutations: always captures the
 * error (telemetry) and invalidates the affected query, and optionally shows a
 * success/error toast. Each card supplies its mutation fn, invalidation key, and
 * toast copy; the helper owns the identical `captureError + invalidate + toast`
 * boilerplate and makes the missing-`onError` class structurally impossible.
 *
 * Writes to the same settings resource (same `invalidate` key) share one
 * mutation scope, so they reach the server strictly in submission order and
 * the latest submitted value is the one persisted last. A write submitted
 * while an earlier one is in flight waits (paused, `isPending`) until the
 * earlier one settles, whether it succeeded or failed.
 */
export const useSettingsMutation = <TVariables = void, TData = unknown>(
  options: UseSettingsMutationOptions<TVariables, TData>,
) => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  const invalidate = async () =>
    await queryClient.invalidateQueries({ queryKey: options.invalidate });

  // Fire-and-forget: awaiting invalidation here would keep the mutation
  // `isPending` until the refetch resolves, delaying the success toast and
  // re-enabling of the triggering control. The `.catch` on the same line
  // keeps this out of the detached-promise ratchet and routes a failed
  // refetch to telemetry instead of an unhandled rejection.
  const invalidateInBackground = (): void => {
    invalidate().catch((error: unknown) => analytics.captureError(error));
  };

  const invalidatesOnSettle = options.invalidateOn === "settled";

  return useMutation({
    scope: { id: settingsMutationScopeId(options.invalidate) },
    mutationFn: options.mutationFn,
    onSuccess: (data, variables) => {
      if (!invalidatesOnSettle) {
        invalidateInBackground();
      }
      if (options.successToast) {
        stellaToast.add({
          title: options.successToast.title,
          ...(options.successToast.description
            ? { description: options.successToast.description }
            : {}),
          type: "success",
        });
      }
      options.onSuccess?.(data, variables);
    },
    ...(invalidatesOnSettle
      ? {
          onSettled: () => {
            invalidateInBackground();
          },
        }
      : {}),
    onError: (error, variables) => {
      analytics.captureError(error);
      if (options.errorToast) {
        notifyUserError(error, options.errorToast.title, {
          ...(options.errorToast.description
            ? {
                description: userErrorFromThrown(
                  error,
                  options.errorToast.description,
                ),
              }
            : {}),
        });
      }
      options.onError?.(error, variables);
    },
  });
};
