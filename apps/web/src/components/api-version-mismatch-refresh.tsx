import { createContext, use, useState } from "react";
import type { PropsWithChildren } from "react";

import { useRouterState } from "@tanstack/react-router";
import { panic } from "better-result";
import * as v from "valibot";

import { env } from "@/env";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { browserApiRootUrl } from "@/lib/api-url";
import { fetchWithTimeout } from "@/lib/fetch";
import { compareSemver } from "@/lib/semver-compare";

import { shouldRefreshAfterNavigation } from "./api-version-mismatch-refresh.logic";

export const ApiVersionMismatchProvider = ({ children }: PropsWithChildren) => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  return (
    <ApiVersionMismatchReporterContext value={setServerVersion}>
      {serverVersion ? (
        <VersionRefreshObserver key={serverVersion} pathname={pathname} />
      ) : null}
      {children}
    </ApiVersionMismatchReporterContext>
  );
};

export const ApiVersionMismatchReporter = () => {
  const serverVersion = useAvailableServerVersion();
  const reportServerVersion = useVersionMismatchReporter();

  // Keep the mismatch in the root provider after this protected-route reporter
  // unmounts, so the persistent observer can refresh at the new pathname.
  useExternalSyncEffect(() => {
    reportServerVersion(serverVersion);
  }, [reportServerVersion, serverVersion]);

  return null;
};

const FIVE_MIN_MS = 5 * 60 * 1000;
const ApiVersionMismatchReporterContext = createContext<
  ((serverVersion: string | null) => void) | undefined
>(undefined);

const healthSchema = v.object({
  status: v.literal("ok"),
  version: v.pipe(v.string(), v.minLength(1)),
});

const useAvailableServerVersion = (): string | null => {
  // Selfhost has its own GitHub-release-driven update banner.
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

  return compareSemver(serverVersion, installedVersion) > 0
    ? serverVersion
    : null;
};

type VersionRefreshObserverProps = {
  pathname: string;
};

const VersionRefreshObserver = ({ pathname }: VersionRefreshObserverProps) => {
  const [detectedPathname] = useState(pathname);
  const refreshAfterNavigation = shouldRefreshAfterNavigation({
    currentPathname: pathname,
    detectedPathname,
  });

  // A completed SPA navigation is a safe update boundary: route blockers have
  // already saved, discarded, or refused local-only work before this changes.
  useExternalSyncEffect(() => {
    if (refreshAfterNavigation) {
      window.location.reload();
    }
  }, [refreshAfterNavigation]);

  return null;
};

const useVersionMismatchReporter = () => {
  const reportServerVersion = use(ApiVersionMismatchReporterContext);
  if (reportServerVersion === undefined) {
    return panic(
      "ApiVersionMismatchReporter must be used within ApiVersionMismatchProvider",
    );
  }
  return reportServerVersion;
};
