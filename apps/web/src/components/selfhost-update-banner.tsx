import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { env } from "@/env";
import { logDevError } from "@/lib/errors/utils";
import { sanitizeHref } from "@/lib/sanitize-href";
import { compareSemver } from "@/lib/semver-compare";

const RELEASES_API_URL =
  "https://api.github.com/repos/stella/stella/releases/latest";
const DISMISSED_KEY_PREFIX = "stella:selfhost-update-dismissed:";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
  const [dismissed, setDismissed] = useState(false);

  const enabled = env.VITE_SELFHOST;
  const installedVersion = __APP_VERSION__;

  const { data: release } = useQuery({
    queryKey: ["selfhost-update-check"],
    enabled,
    staleTime: ONE_DAY_MS,
    refetchInterval: ONE_DAY_MS,
    retry: false,
    queryFn: async (): Promise<Release | null> => {
      try {
        const response = await fetch(RELEASES_API_URL, {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!response.ok) {
          return null;
        }
        const json = (await response.json()) as unknown;
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
  if (
    !dismissed &&
    typeof localStorage !== "undefined" &&
    localStorage.getItem(dismissedKey) === "1"
  ) {
    return null;
  }
  if (dismissed) {
    return null;
  }

  const handleDismiss = () => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(dismissedKey, "1");
    }
    setDismissed(true);
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
    <div className="border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
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
        <button
          aria-label={t("selfhost.dismissUpdate")}
          className="-me-1 rounded-sm p-1 hover:bg-amber-100 dark:hover:bg-amber-900/40"
          onClick={handleDismiss}
          type="button"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
};
