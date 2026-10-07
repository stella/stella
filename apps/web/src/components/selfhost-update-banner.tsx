import { useState } from "react";

import { useTranslations } from "use-intl";
import * as v from "valibot";

import { FetchBoundaryError } from "@stll/errors";
import { fetchWithTimeout } from "@stll/fetch";
import { DAY_IN_MS } from "@stll/time";
import { ExternalLinkIcon, XIcon } from "@stll/ui/icons";

import Tooltip from "@/components/tooltip";
import { env } from "@/env";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useLocalStorageFlag } from "@/hooks/use-local-storage-flag";
import { deviceStorage } from "@/lib/account/browser-storage";
import { ClientTelemetryError } from "@/lib/errors/telemetry";
import { sanitizeHref } from "@/lib/sanitize-href";
import { compareSemver } from "@/lib/semver-compare";
import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";

const RELEASES_API_URL =
  "https://api.github.com/repos/stella/stella/releases/latest";
const DISMISSED_KEY_PREFIX = "stella:selfhost-update-dismissed:";

const releaseSchema = v.object({
  tag_name: v.string(),
  html_url: v.pipe(v.string(), v.url()),
  prerelease: v.boolean(),
  draft: v.boolean(),
});

const stripPrefix = (tag: string): string =>
  tag.startsWith("v") ? tag.slice(1) : tag;

export const SelfhostUpdateBanner = () => {
  const t = useTranslations();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  const enabled = env.VITE_SELFHOST;
  const installedVersion = __APP_VERSION__;

  const releaseQuery = useChromeQuery({
    queryKey: ["selfhost-update-check"],
    enabled,
    staleTime: DAY_IN_MS,
    refetchInterval: DAY_IN_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetchWithTimeout(RELEASES_API_URL, {
        headers: { Accept: "application/vnd.github+json" },
        signal,
        timeoutMs: 8000,
      });
      if (!response.ok) {
        throw new FetchBoundaryError({
          url: RELEASES_API_URL,
          status: response.status,
          statusText: response.statusText,
          message: "Release update check failed",
        });
      }
      const json: unknown = await response.json();
      const parsed = v.safeParse(releaseSchema, json);
      if (!parsed.success) {
        throw new ClientTelemetryError({
          area: "selfhost-update-check",
          message: "Release update response failed validation",
        });
      }
      return parsed.output;
    },
  });
  const releaseView = useQueryView(releaseQuery);
  useQueryViewError(releaseView);
  const release = releaseView.type === "items" ? releaseView.items : undefined;
  const latestVersion = release ? stripPrefix(release.tag_name) : "";
  const dismissedKey = `${DISMISSED_KEY_PREFIX}${latestVersion}`;
  const isPersistedDismissal = useLocalStorageFlag(dismissedKey);

  if (!enabled || !release || release.draft) {
    return null;
  }

  if (compareSemver(latestVersion, installedVersion) <= 0) {
    return null;
  }

  // Per-version dismissal: dismissing v0.0.2 doesn't suppress the
  // banner for v0.0.3 later. Stored in localStorage so it survives
  // tab refreshes within the same install.
  if (dismissedVersion === latestVersion) {
    return null;
  }
  if (isPersistedDismissal) {
    return null;
  }

  const handleDismiss = () => {
    deviceStorage("local").setItem(dismissedKey, "1");
    setDismissedVersion(latestVersion);
  };

  // GitHub's API only ever returns http(s) URLs, but route through
  // sanitizeHref anyway so the linter rule (and a hypothetical
  // proxy/MITM serving a malformed payload) can't smuggle a
  // javascript: URL into a click target.
  const safeHref = sanitizeHref(release.html_url);
  if (!safeHref) {
    return null;
  }

  return (
    <div className="bg-warning/10 text-warning-foreground border-b px-4 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span>
          {t("selfhost.updateAvailable", {
            installed: installedVersion,
            latest: latestVersion,
          })}{" "}
          <a
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
            href={sanitizeHref(release.html_url)}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t("selfhost.viewReleaseNotes")}
            <ExternalLinkIcon className="size-3" />
          </a>
        </span>
        <Tooltip
          content={t("selfhost.dismissUpdate")}
          render={
            <button
              aria-label={t("selfhost.dismissUpdate")}
              className="hover:bg-warning/20 -me-1 rounded-sm p-1"
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
