import { hashKey, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { Result, TaggedError } from "better-result";

import { stellaToast } from "@stll/ui/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { fetchSession } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { readQueryResult } from "@/lib/errors/query-result";
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

/**
 * A settings write is bound to the organization whose settings page it was
 * submitted from. When the session's active organization is a different one
 * by the time the write would be sent (an organization switch in this or
 * another tab), the write is not sent and fails with this error.
 */
export class SettingsOrganizationChangedError extends TaggedError(
  "SettingsOrganizationChangedError",
)<{
  message: string;
  submittedOrganizationId: string;
}> {}

/**
 * Re-reads the organization the server resolves for this session right
 * before a write is sent, past the session cookie cache.
 */
const checkSettingsOrganization = async (
  submittedOrganizationId: string,
): Promise<Result<void, SettingsOrganizationChangedError>> => {
  const session = await fetchSession({ bypassCookieCache: true });
  return session?.session.activeOrganizationId === submittedOrganizationId
    ? Result.ok()
    : Result.err(
        new SettingsOrganizationChangedError({
          message:
            "The active organization changed before this settings write was sent.",
          submittedOrganizationId,
        }),
      );
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
 *
 * Settings requests carry no organization id; the server applies them to the
 * session's active organization when they arrive. Every write therefore
 * re-reads the server's active organization right before it is sent and is
 * refused with `SettingsOrganizationChangedError` (error toast, `onError`)
 * when that is no longer the organization it was submitted for.
 */
export const useSettingsMutation = <TVariables = void, TData = unknown>(
  options: UseSettingsMutationOptions<TVariables, TData>,
) => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuthenticatedUser();

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
    mutationFn: async (variables: TVariables) => {
      // A changed organization rejects before the write is sent.
      readQueryResult(await checkSettingsOrganization(activeOrganizationId));
      return await options.mutationFn(variables);
    },
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
