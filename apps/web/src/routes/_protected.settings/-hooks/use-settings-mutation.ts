import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";

import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

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

/**
 * Shared plumbing for organization-settings mutations: always captures the
 * error (telemetry) and invalidates the affected query, and optionally shows a
 * success/error toast. Each card supplies its mutation fn, invalidation key, and
 * toast copy; the helper owns the identical `captureError + invalidate + toast`
 * boilerplate and makes the missing-`onError` class structurally impossible.
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
  const invalidateInBackground = () =>
    invalidate().catch((error: unknown) => analytics.captureError(error));

  const invalidatesOnSettle = options.invalidateOn === "settled";

  return useMutation({
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
        stellaToast.add({
          title: options.errorToast.title,
          ...(options.errorToast.description
            ? {
                description: userErrorFromThrown(
                  error,
                  options.errorToast.description,
                ),
              }
            : {}),
          type: "error",
        });
      }
      options.onError?.(error, variables);
    },
  });
};
