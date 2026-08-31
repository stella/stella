import { useState } from "react";

import { useRouterState } from "@tanstack/react-router";
import { RefreshCwIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { env } from "@/env";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLocalStorageFlag } from "@/hooks/use-local-storage-flag";
import { browserApiRootUrl } from "@/lib/api-url";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { fetchWithTimeout } from "@/lib/fetch";
import { compareSemver } from "@/lib/semver-compare";

import { shouldRefreshAfterNavigation } from "./api-version-mismatch-banner.logic";

const FIVE_MIN_MS = 5 * 60 * 1000;
const DISMISSED_KEY_PREFIX = "stella:api-version-mismatch-dismissed:";

const healthSchema = v.object({
  status: v.literal("ok"),
  version: v.pipe(v.string(), v.minLength(1)),
});

const handleRefresh = () => {
  window.location.reload();
};

type AvailableVersionBannerProps = {
  installedVersion: string;
  pathname: string;
  serverVersion: string;
};

const AvailableVersionBanner = ({
  installedVersion,
  pathname,
  serverVersion,
}: AvailableVersionBannerProps) => {
  const t = useTranslations();
  const [detectedPathname] = useState(pathname);
  const [dismissed, setDismissed] = useState(false);
  const dismissedKey = `${DISMISSED_KEY_PREFIX}${serverVersion}`;
  const isPersistedDismissal = useLocalStorageFlag(dismissedKey);
  const refreshAfterNavigation = shouldRefreshAfterNavigation({
    currentPathname: pathname,
    detectedPathname,
  });

  // A completed SPA navigation is a safe update boundary: route blockers have
  // already saved, discarded, or refused local-only work before this changes.
  useExternalSyncEffect(() => {
    if (refreshAfterNavigation) {
      handleRefresh();
    }
  }, [refreshAfterNavigation]);

  if (dismissed || isPersistedDismissal) {
    return null;
  }

  const handleDismiss = () => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(dismissedKey, "1");
    }
    setDismissed(true);
  };

  return (
    <div
      className={cn(
        "bg-accent text-foreground shrink-0 border-b px-4 text-sm",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <div className="flex h-full items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate">
            {t("app.versionMismatch.message", {
              installed: installedVersion,
              latest: serverVersion,
            })}
          </span>
          <button
            className="relative inline-flex shrink-0 items-center gap-1 underline underline-offset-2 after:absolute after:min-h-11 after:min-w-11 hover:no-underline"
            onClick={handleRefresh}
            type="button"
          >
            <RefreshCwIcon className="size-3" />
            {t("app.versionMismatch.refresh")}
          </button>
        </div>
        <Tooltip
          content={t("app.versionMismatch.dismiss")}
          render={
            <button
              aria-label={t("app.versionMismatch.dismiss")}
              className="hover:bg-accent-foreground/10 relative -me-1 shrink-0 rounded-sm p-1 after:absolute after:inset-1/2 after:min-h-11 after:min-w-11 after:-translate-x-1/2 after:-translate-y-1/2"
              onClick={handleDismiss}
              type="button"
            />
          }
        >
          <XIcon className="size-4" />
        </Tooltip>
      </div>
    </div>
  );
};

export const ApiVersionMismatchBanner = () => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  // Selfhost has its own GitHub-release-driven banner. Skip there
  // so the two don't fight for the same slot.
  const enabled = !env.VITE_SELFHOST;
  const installedVersion = __APP_VERSION__;

  const { data: serverVersion } = useChromeQuery({
    queryKey: ["api-version-check"],
    enabled,
    staleTime: FIVE_MIN_MS,
    refetchInterval: FIVE_MIN_MS,
    refetchIntervalInBackground: false,
    retry: false,
    queryFn: async ({ signal }): Promise<string | null> => {
      const response = await fetchWithTimeout(browserApiRootUrl("/health"), {
        cache: "no-store",
        signal,
        timeoutMs: 8000,
      });
      if (!response.ok) {
        return null;
      }
      const json: unknown = await response.json();
      const parsed = v.safeParse(healthSchema, json);
      return parsed.success ? parsed.output.version : null;
    },
  });

  if (!enabled || !serverVersion) {
    return null;
  }

  if (compareSemver(serverVersion, installedVersion) <= 0) {
    return null;
  }

  return (
    <AvailableVersionBanner
      installedVersion={installedVersion}
      key={serverVersion}
      pathname={pathname}
      serverVersion={serverVersion}
    />
  );
};
