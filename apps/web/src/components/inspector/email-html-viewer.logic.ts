import { panic } from "better-result";

import type {
  EmailBodyFold,
  EmailBodyFoldKind,
} from "@/lib/files/email-preview";

export const parseEmailDate = (value: string | null): Date | null => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export type EmailAttachmentSize = {
  unit: "byte" | "gigabyte" | "kilobyte" | "megabyte";
  value: number;
};

export const getEmailAttachmentSize = (
  sizeBytes: number,
): EmailAttachmentSize => {
  if (sizeBytes < 1000) {
    return { unit: "byte", value: sizeBytes };
  }

  if (sizeBytes < 1000 * 1000) {
    return { unit: "kilobyte", value: sizeBytes / 1000 };
  }

  if (sizeBytes < 1000 * 1000 * 1000) {
    return { unit: "megabyte", value: sizeBytes / (1000 * 1000) };
  }

  return { unit: "gigabyte", value: sizeBytes / (1000 * 1000 * 1000) };
};

export type EmailBodyFoldLabels = Record<
  EmailBodyFoldKind,
  { hide: string; show: string }
>;

const EMPTY_FOLD_SUMMARY_RE =
  /<summary data-stella-email-fold-summary="(?<id>fold-\d+)"><\/summary>/gu;

export const localizeEmailBodyHtml = ({
  bodyFolds,
  bodyHtml,
  labels,
}: {
  bodyFolds: readonly EmailBodyFold[];
  bodyHtml: string;
  labels: EmailBodyFoldLabels;
}): string => {
  const markerIds = Array.from(
    bodyHtml.matchAll(EMPTY_FOLD_SUMMARY_RE),
    (match) =>
      match.groups?.["id"] ?? panic("Email fold marker is missing its id"),
  );
  const declaredIds = bodyFolds.map(({ id }) => id);
  if (
    new Set(markerIds).size !== markerIds.length ||
    new Set(declaredIds).size !== declaredIds.length ||
    markerIds.length !== declaredIds.length ||
    markerIds.some((id) => !declaredIds.includes(id))
  ) {
    return panic("Email fold metadata does not match its body markers");
  }

  let localized = bodyHtml;
  for (const { id, kind } of bodyFolds) {
    const marker = `<summary data-stella-email-fold-summary="${id}"></summary>`;
    const label = labels[kind];
    const summary = [
      `<summary data-stella-email-fold-summary="${id}">`,
      `<span data-stella-email-fold-label="closed">${escapeHtml(label.show)}</span>`,
      `<span data-stella-email-fold-label="open">${escapeHtml(label.hide)}</span>`,
      "</summary>",
    ].join("");
    localized = localized.replace(marker, () => summary);
  }
  return localized;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
