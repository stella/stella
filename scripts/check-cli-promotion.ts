#!/usr/bin/env bun
import { readPromotedCliTarget } from "./promoted-cli-target";

const INSTALLED_VERSION =
  /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/u;

type CheckCliPromotionOptions = Parameters<typeof readPromotedCliTarget>[0] & {
  installedVersion: string;
};

export const checkCliPromotion = async ({
  installedVersion,
  ...options
}: CheckCliPromotionOptions) => {
  if (!INSTALLED_VERSION.test(installedVersion)) {
    return {
      status: "failed" as const,
      reason: "contract_error" as const,
      message: "Installed CLI returned an invalid version",
    };
  }
  const promotion = await readPromotedCliTarget(options);
  if (promotion.status === "failed") {
    return promotion;
  }
  const target = { target: promotion.version, deadline: promotion.deadline };
  if (Bun.semver.order(installedVersion, promotion.version) >= 0) {
    return { status: "passed" as const, reason: "ok" as const, ...target };
  }
  return options.now < Date.parse(promotion.deadline) / 1000
    ? {
        status: "skipped" as const,
        reason: "pending_release" as const,
        ...target,
      }
    : {
        status: "failed" as const,
        reason: "publish_lagging" as const,
        ...target,
      };
};

if (import.meta.main) {
  try {
    const result = await checkCliPromotion({
      installedVersion: Bun.argv.at(2) ?? "",
      timeoutMs: Number(process.env["JOURNEY_REGISTRY_TIMEOUT_MS"] ?? "10000"),
      now: Math.floor(Date.now() / 1000),
      githubToken: process.env["GITHUB_TOKEN"],
      ...(process.env["JOURNEY_RELEASES_API_URL"]
        ? { releasesApiUrl: process.env["JOURNEY_RELEASES_API_URL"] }
        : {}),
    });
    console.log(JSON.stringify(result));
  } catch {
    console.log(
      JSON.stringify({
        status: "failed",
        reason: "contract_error",
        message: "Could not assess promoted CLI publication",
      }),
    );
  }
}
