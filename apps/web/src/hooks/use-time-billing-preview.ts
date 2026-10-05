import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { env } from "@/env";
import {
  isTimeBillingOffered,
  TIME_BILLING_SOURCE,
  timeBillingSource,
} from "@/hooks/use-time-billing-preview.logic";
import type { TimeBillingSource } from "@/hooks/use-time-billing-preview.logic";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { useDevStore } from "@/lib/dev-store";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import { useQueryView } from "@/lib/use-query-view";
import { deploymentFeaturesOptions } from "@/queries/deployment-features";

// Navigation surfaces (sidebar, timer, palette, settings cards) follow the
// build flag or the per-browser preview. Routes additionally open in local
// development, so a direct load of an invoice, timesheet or expense route
// resolves the same on server and client; these routes are protected
// client-only surfaces with no server render to diverge.
const TIME_BILLING_SCOPE = { surface: "surface", route: "route" } as const;

type TimeBillingScope =
  (typeof TIME_BILLING_SCOPE)[keyof typeof TIME_BILLING_SCOPE];

const sourceFor = (
  scope: TimeBillingScope,
  devPreviewEnabled: boolean,
): TimeBillingSource =>
  timeBillingSource({
    buildEnabled: env.VITE_FEATURE_TIME_BILLING,
    previewRequested:
      (scope === TIME_BILLING_SCOPE.route && import.meta.env.DEV) ||
      (betaFeaturesAvailable() && devPreviewEnabled),
  });

const resolveOffered = async (
  queryClient: QueryClient,
  scope: TimeBillingScope,
): Promise<boolean> => {
  const source = sourceFor(scope, useDevStore.getState().timeBillingPreview);
  if (source !== TIME_BILLING_SOURCE.preview) {
    return isTimeBillingOffered(source, undefined);
  }
  const features = await ensureRouteQueryData(
    queryClient,
    deploymentFeaturesOptions,
  );
  return isTimeBillingOffered(source, features.timeBilling);
};

/**
 * Starts the server's answer with the signed-in shell when a preview asks for
 * time billing, so the chrome's first render already knows it.
 */
export const prefetchTimeBillingServerState = async (
  queryClient: QueryClient,
  onError: (error: unknown) => void,
): Promise<void> => {
  const source = sourceFor(
    TIME_BILLING_SCOPE.route,
    useDevStore.getState().timeBillingPreview,
  );
  if (source !== TIME_BILLING_SOURCE.preview) {
    return;
  }
  await prefetchRouteQuery(queryClient, deploymentFeaturesOptions, onError);
};

/** Whether a route loader may offer time billing's navigation surfaces. */
export const isTimeBillingPreviewEnabled = async (
  queryClient: QueryClient,
): Promise<boolean> =>
  await resolveOffered(queryClient, TIME_BILLING_SCOPE.surface);

/** Whether a time-billing route may load and fetch its data. */
export const isTimeBillingRouteEnabled = async (
  queryClient: QueryClient,
): Promise<boolean> =>
  await resolveOffered(queryClient, TIME_BILLING_SCOPE.route);

const useOffered = (source: TimeBillingSource): boolean => {
  const view = useQueryView(
    useQuery({
      ...deploymentFeaturesOptions,
      enabled: source === TIME_BILLING_SOURCE.preview,
    }),
  );
  // A pending or failed answer is unknown and offers nothing. A failed
  // refetch keeps the answer the server already gave.
  switch (view.type) {
    case "pending":
    case "error":
    case "empty":
      return isTimeBillingOffered(source, undefined);
    case "items":
      return isTimeBillingOffered(source, view.items.timeBilling);
    default:
      view satisfies never;
      return panic(`Unknown query view: ${String(view)}`);
  }
};

export const useTimeBillingPreviewEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.timeBillingPreview);
  return useOffered(sourceFor(TIME_BILLING_SCOPE.surface, devPreviewEnabled));
};

/** The component twin of `isTimeBillingRouteEnabled`. */
export const useTimeBillingRouteEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.timeBillingPreview);
  return useOffered(sourceFor(TIME_BILLING_SCOPE.route, devPreviewEnabled));
};

/**
 * Whether the beta page offers the time-billing preview toggle: only when the
 * server serves time billing, so ticking it never reaches a route that is
 * off. A build that already ships time billing asks nothing.
 */
export const useTimeBillingPreviewOffered = (): boolean =>
  useOffered(
    timeBillingSource({
      buildEnabled: env.VITE_FEATURE_TIME_BILLING,
      previewRequested: true,
    }),
  );
