import { panic } from "better-result";

import { isEligibleLegislationExpression } from "@stll/api-contract/legislation-expression";
import { versionCoversDate } from "@stll/api-contract/statute-version";
import { DAY_IN_MS } from "@stll/time";
import { diffWords } from "@stll/ui/review-word-diff";

import type { ProvisionVersion, StatuteTimelineHistory } from "./parse";

export const mergeHistory = (
  history: StatuteTimelineHistory,
  page: StatuteTimelineHistory,
) => {
  if (history.eli !== page.eli || history.anchor !== page.anchor) {
    return page;
  }
  const versions = new Map(
    history.items.map((item) => [item.documentId, item]),
  );
  for (const item of page.items) {
    versions.set(item.documentId, item);
  }
  return {
    eli: history.eli,
    anchor: history.anchor,
    items: [...versions.values()],
    nextCursor: page.nextCursor,
  };
};

export const isCurrentVersion = versionCoversDate;

export const versionWording = (version: ProvisionVersion) => {
  switch (version.status) {
    case "found":
      return {
        type: "wording",
        text: version.text,
        truncated: version.truncated,
      } as const;
    case "text_withheld":
      return { type: "withheld", message: version.message } as const;
    default:
      return panic("Unknown provision status", version satisfies never);
  }
};

export const compareAdjacentVersions = (
  items: ProvisionVersion[],
  documentId: string,
) => {
  const index = items.findIndex((item) => item.documentId === documentId);
  if (index === -1) {
    return null;
  }
  const newer = items.at(index);
  const older = items.at(index + 1);
  if (newer?.status !== "found" || older?.status !== "found") {
    return null;
  }
  return {
    segments: diffWords(older.text, newer.text).map(({ type, token }) => ({
      type,
      text: token,
    })),
    truncated: newer.truncated || older.truncated,
  };
};

// Null endpoints remain open; the chart clips them to the visible domain only.
export const timelineWindows = (items: ProvisionVersion[], today: string) => {
  const bounds = items
    .flatMap((item) => [item.versionValidFrom, item.versionValidTo])
    .filter((date) => date !== null)
    .map((date) => new Date(date).getTime());
  const now = new Date(today).getTime();
  const minimum = Math.min(now, ...bounds);
  const maximum = Math.max(now, ...bounds);
  const padding = Math.max((maximum - minimum) * 0.05, DAY_IN_MS);
  return {
    domain: [new Date(minimum - padding), new Date(maximum + padding)] as const,
    rows: items.map((item) => ({
      id: item.documentId,
      current: isCurrentVersion(item, today),
      eligible: isEligibleLegislationExpression(item),
      start: new Date(item.versionValidFrom ?? minimum - padding),
      end: new Date(item.versionValidTo ?? maximum + padding),
      openStart: item.versionValidFrom === null,
      openEnd: item.versionValidTo === null,
    })),
  };
};
