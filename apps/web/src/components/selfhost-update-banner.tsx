import { useState } from "react";

import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import Tooltip from "@/components/tooltip";
import { env } from "@/env";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { logDevError } from "@/lib/errors/utils";
import { fetchWithTimeout } from "@/lib/fetch";
import { sanitizeHref } from "@/lib/sanitize-href";
import { compareSemver } from "@/lib/semver-compare";
import { DAY_IN_MS } from "@/lib/time";

const RELEASES_API_URL =
  "https://api.github.com/repos/stella/stella/releases/latest";
const DISMISSED_KEY_PREFIX = "stella:selfhost-update-dismissed:";

const releaseSchema = v.object({
  tag_name: v.string(),
  html_url: v.pipe(v.string(), v.url()),
  prerelease: v.boolean(),
  draft: v.boolean(),
});

type Release = v.InferOutput<typeof releaseSchema>;

const stripPrefix = (tag: string): string =>
  tag.startsWith("v") ? tag.slice(1) : tag;

export const SelfhostUpdateBanner = () => {
  const t = useTranslations();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  const enabled = env.VITE_SELFHOST;
  const installedVersion = __APP_VERSION__;

  const { data: release } = useChromeQuery({
    queryKey: ["selfhost-update-check"],
    enabled,
    staleTime: DAY_IN_MS,
    refetchInterval: DAY_IN_MS,
    retry: false,
    queryFn: async ({ signal }): Promise<Release | null> => {
      try {
        const response = await fetchWithTimeout(RELEASES_API_URL, {
          headers: { Accept: "application/vnd.github+json" },
          signal,
          timeoutMs: 8000,
        });
        if (!response.ok) {
          return null;
        }
        const json: unknown = await response.json();
        const parsed = v.safeParse(releaseSchema, json);
        return parsed.success ? parsed.output : null;
      } catch (error: unknown) {
        logDevError(error);
        return null;
      }
    },
  });

  if (!enabled || !release || release.draft) {
    return null;
  }

  const latestVersion = stripPrefix(release.tag_name);
  if (compareSemver(latestVersion, installedVersion) <= 0) {
    return null;
  }

  // Per-version dismissal: dismissing v0.0.2 doesn't suppress the
  // banner for v0.0.3 later. Stored in localStorage so it survives
  // tab refreshes within the same install.
  const dismissedKey = `${DISMISSED_KEY_PREFIX}${latestVersion}`;
  if (dismissedVersion === latestVersion) {
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
            href={safeHref}
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
