import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { RefreshCwIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { env } from "@/env";
import { compareSemver } from "@/lib/semver-compare";

const FIVE_MIN_MS = 5 * 60 * 1000;
const DISMISSED_KEY_PREFIX = "stella:api-version-mismatch-dismissed:";

const healthSchema = v.object({
  status: v.literal("ok"),
  version: v.pipe(v.string(), v.minLength(1)),
});

export const ApiVersionMismatchBanner = () => {
  const t = useTranslations();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  // Selfhost has its own GitHub-release-driven banner. Skip there
  // so the two don't fight for the same slot.
  const enabled = !env.VITE_SELFHOST;
  const installedVersion = __APP_VERSION__;

  const { data: serverVersion } = useQuery({
    queryKey: ["api-version-check"],
    enabled,
    staleTime: FIVE_MIN_MS,
    refetchInterval: FIVE_MIN_MS,
    refetchIntervalInBackground: false,
    retry: false,
    queryFn: async (): Promise<string | null> => {
      const response = await fetch(`${env.VITE_API_URL}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
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

  // Per-version dismissal so dismissing 0.0.8 doesn't suppress
  // the banner when 0.0.9 ships.
  const dismissedKey = `${DISMISSED_KEY_PREFIX}${serverVersion}`;
  if (dismissedVersion === serverVersion) {
    return null;
  }
  if (
    typeof localStorage !== "undefined" &&
    localStorage.getItem(dismissedKey) === "1"
  ) {
    return null;
  }

  const handleDismiss = () => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(dismissedKey, "1");
    }
    setDismissedVersion(serverVersion);
  };

  const handleRefresh = () => {
    window.location.reload();
  };

  return (
    <div className="bg-accent text-foreground border-b px-4 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span>
          {t("app.versionMismatch.message", {
            installed: installedVersion,
            latest: serverVersion,
          })}{" "}
          <button
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
            onClick={handleRefresh}
            type="button"
          >
            <RefreshCwIcon className="size-3" />
            {t("app.versionMismatch.refresh")}
          </button>
        </span>
        <button
          aria-label={t("app.versionMismatch.dismiss")}
          className="hover:bg-accent-foreground/10 -me-1 rounded-sm p-1"
          onClick={handleDismiss}
          type="button"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
};
