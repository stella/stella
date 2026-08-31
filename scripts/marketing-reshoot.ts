#!/usr/bin/env bun

// Re-records only the product-story marketing captures that
// scripts/check-marketing-recordings.ts finds stale, so a release reshoot
// never pays for re-recording the whole matrix when a handful of scenes
// drifted. See "Reshooting on release" in
// apps/landing/public/media/products/README.md for the full flow this
// automates, and that file's "Refreshing the images" section for the
// underlying manual steps.

import nodePath from "node:path";

import { computeVerdicts, type Verdict } from "./check-marketing-recordings";
import { syncProductMedia } from "./product-media";

const ROOT_DIR = nodePath.resolve(import.meta.dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

// Matches the recorder's own fallbacks (record-product-story.ts) and the
// runbook's documented local-stack URLs.
const DEFAULT_WEB_URL = "http://localhost:3000";
const DEFAULT_API_URL = "http://localhost:3001";
const WEB_URL = process.env["E2E_WEB_URL"] ?? DEFAULT_WEB_URL;
const API_URL = process.env["E2E_API_URL"] ?? DEFAULT_API_URL;

const PREFLIGHT_TIMEOUT_MS = 5000;
const MANIFEST_PATH =
  "apps/landing/public/media/products/recordings-manifest.json";
const PRODUCT_MEDIA_MANIFEST_PATH = "apps/landing/product-media-manifest.json";

class MarketingReshootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketingReshootError";
  }
}

const staleCaptureIds = (verdicts: readonly Verdict[]): string[] => [
  ...new Set(
    verdicts
      .filter(({ status }) => status === "STALE")
      .map(({ captureId }) => captureId),
  ),
];

const reshootCommand = (captureIds: readonly string[]) =>
  [
    "cd apps/web &&",
    `E2E_WEB_URL=${WEB_URL}`,
    `E2E_API_URL=${API_URL}`,
    `MARKETING_CAPTURE=${captureIds.join(",")}`,
    "bun run capture:product-story",
  ].join(" ");

// A real HTTP round trip rather than a TCP connect: a stack whose API
// container is up but crash-looping still answers connect() and would
// otherwise be reported reachable right before the recorder fails against it.
const isReachable = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
};

// Strip trailing slashes with a linear scan rather than `/\/+$/`, whose
// worst case backtracks super-linearly (the repo's ratchet guards against it).
const withoutTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
};

const apiHealthUrl = (apiUrl: string) =>
  new URL("health", `${withoutTrailingSlashes(apiUrl)}/`).toString();

const printStartStackInstructions = () => {
  process.stdout.write(
    [
      "marketing-reshoot: app stack unreachable; this script does not start servers.",
      "Start it, seed it, then re-run `bun run marketing:reshoot`:",
      "",
      "  bun run dev --no-browser",
      "  bun --filter @stll/api db:seed-test-user",
      "  bun --filter @stll/api db:seed-dev",
      "",
      "In a git worktree the dev runner assigns offset ports (it prints them on",
      "start); pass them as E2E_WEB_URL and E2E_API_URL. Always use `localhost`",
      "for E2E_API_URL even if the runner prints `127.0.0.1` — see",
      "apps/landing/public/media/products/README.md for why.",
      "",
    ].join("\n"),
  );
};

const printFollowUpInstructions = (recordedIds: readonly string[]) => {
  const idsList = recordedIds.map((id) => `"${id}"`).join(", ");
  process.stdout.write(
    [
      "",
      "marketing-reshoot: recording succeeded. This script does not commit —",
      "land the result in two commits, matching the existing convention:",
      "",
      "1. Regenerate the immutable media manifest, publish the objects, then",
      "   commit the two manifests. The recording binaries stay ignored:",
      "",
      "   bun run marketing:media:manifest",
      '   PRODUCT_MEDIA_S3_BUCKET="$(gh variable get DOWNLOADS_BUCKET)" bun run marketing:media:publish',
      `   git add ${MANIFEST_PATH} ${PRODUCT_MEDIA_MANIFEST_PATH}`,
      '   git commit -m "feat(landing): re-record marketing captures"',
      "",
      "2. In a separate commit, restamp recordedAtCommit to the commit that",
      "   just landed the footage (the recorder stamped the pre-commit HEAD,",
      "   so it now points one commit behind):",
      "",
      "   NEW_HEAD=$(git rev-parse HEAD)",
      `   jq --arg commit "$NEW_HEAD" --argjson ids '[${idsList}]' \\`,
      "     '.entries |= map(if (.captureId as $c | $ids | index($c) != null) then .recordedAtCommit = $commit else . end)' \\",
      `     ${MANIFEST_PATH} > /tmp/recordings-manifest.json`,
      `   mv /tmp/recordings-manifest.json ${MANIFEST_PATH}`,
      `   git add ${MANIFEST_PATH}`,
      '   git commit -m "chore(landing): stamp recording manifest against the committed tree"',
      "",
    ].join("\n"),
  );
};

const printDryRun = (staleIds: readonly string[]) => {
  process.stdout.write(
    [
      `marketing-reshoot: --dry-run, ${staleIds.length} capture id(s) stale: ${staleIds.join(", ")}`,
      "would preflight:",
      `  GET ${WEB_URL}/`,
      `  GET ${apiHealthUrl(API_URL)}`,
      "would run:",
      "  bun run marketing:media:sync",
      `  ${reshootCommand(staleIds)}`,
      "",
    ].join("\n"),
  );
};

const runRecorder = (staleIds: readonly string[]) => {
  process.stdout.write(
    `marketing-reshoot: running:\n  ${reshootCommand(staleIds)}\n\n`,
  );
  const result = Bun.spawnSync(["bun", "run", "capture:product-story"], {
    cwd: nodePath.join(ROOT_DIR, "apps/web"),
    env: {
      ...process.env,
      E2E_API_URL: API_URL,
      E2E_WEB_URL: WEB_URL,
      MARKETING_CAPTURE: staleIds.join(","),
    },
    stderr: "inherit",
    stdout: "inherit",
  });
  if (!result.success) {
    throw new MarketingReshootError(
      `capture:product-story exited with code ${String(result.exitCode)}`,
    );
  }
};

const main = async () => {
  const verdicts = computeVerdicts();
  const staleIds = staleCaptureIds(verdicts);

  if (staleIds.length === 0) {
    process.stdout.write(
      `marketing-reshoot: all ${verdicts.length} recordings fresh — nothing to reshoot\n`,
    );
    return;
  }

  if (DRY_RUN) {
    printDryRun(staleIds);
    return;
  }

  const [webUp, apiUp] = await Promise.all([
    isReachable(WEB_URL),
    isReachable(apiHealthUrl(API_URL)),
  ]);
  if (!(webUp && apiUp)) {
    printStartStackInstructions();
    process.exitCode = 2;
    return;
  }

  await syncProductMedia(ROOT_DIR);
  runRecorder(staleIds);

  const afterVerdicts = computeVerdicts();
  const stillStale = new Set(staleCaptureIds(afterVerdicts));
  const nowFresh = staleIds.filter((id) => !stillStale.has(id));

  if (nowFresh.length > 0) {
    process.stdout.write(
      `\nmarketing-reshoot: now fresh: ${nowFresh.join(", ")}\n`,
    );
  }
  if (stillStale.size > 0) {
    process.stdout.write(
      `marketing-reshoot: still stale after re-recording: ${[...stillStale].join(", ")}\n`,
    );
  }

  printFollowUpInstructions(staleIds);
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`marketing-reshoot: ${message}`);
    process.exit(1);
  });
}
