/**
 * Pure helpers shared by the chat message export handler, kept DB-free so the
 * markdown assembly, citation composition, and download-response shape are
 * exhaustively unit-testable without a request or object store.
 */

import { chatPartText } from "@/api/handlers/chat/chat-message-parts";
import type { CitationSection } from "@/api/handlers/chat/export/citation-footnotes";
import type { ChatPart } from "@/api/handlers/chat/types";

const SEARCH_SUMMARY_SOURCES_HEADING = "\n\n### Sources";

const isLegacySearchSummarySourceLine = (line: string): boolean =>
  line.length === 0 || line.startsWith("- ") || line.startsWith("  Excerpt: ");

/**
 * Concatenate a message's text parts into a markdown body, verbatim (no
 * whitespace collapsing — the recap transcript collapses, which would flatten
 * the answer's markdown structure). Non-text parts (tool calls, attachments)
 * are dropped: an exported answer is its prose, not its tool trace.
 */
export const assembleMessageMarkdown = (parts: readonly ChatPart[]): string => {
  const segments: string[] = [];
  for (const part of parts) {
    const text = chatPartText(part);
    if (text !== null && text.trim().length > 0) {
      segments.push(text.trim());
    }
  }
  return segments.join("\n\n");
};

/** Append the citation section to the body, separated by a blank line. The
 *  section is already markdown (headings/lists) so it flows through the shared
 *  renderer with semantic Word styles. */
export const composeExportMarkdown = (
  body: string,
  section: CitationSection,
): string => {
  if (section.markdown.length === 0) {
    return body;
  }
  if (body.length === 0) {
    return section.markdown;
  }
  return `${body}\n\n${section.markdown}`;
};

export type PersistedSearchSummarySources = {
  bodyWithoutSources: string;
  sourceCount: number;
  sourcesMarkdown: string;
};

export const composePersistedSearchSummaryMarkdown = (
  sources: PersistedSearchSummarySources,
  sourcesHeading: string,
): string =>
  `${sources.bodyWithoutSources}\n\n### ${sourcesHeading}${sources.sourcesMarkdown}`;

/**
 * Recognize the trailing Sources block written by `/search/summary/chat`.
 *
 * This recognizes layout only: a level-three English heading followed by zero
 * or more unordered-list items. The caller must use server-owned message
 * metadata, never this model-readable Markdown shape, to decide whether links
 * have trusted search provenance.
 */
export const extractPersistedSearchSummarySources = (
  body: string,
): PersistedSearchSummarySources | null => {
  const headingIndex = body.lastIndexOf(SEARCH_SUMMARY_SOURCES_HEADING);
  if (headingIndex === -1) {
    return null;
  }

  const sources = body.slice(
    headingIndex + SEARCH_SUMMARY_SOURCES_HEADING.length,
  );
  if (sources.length > 0 && !sources.startsWith("\n\n- ")) {
    return null;
  }
  if (
    sources.split("\n").some((line) => !isLegacySearchSummarySourceLine(line))
  ) {
    return null;
  }

  const sourceCount =
    sources.length === 0
      ? 0
      : sources.split("\n").filter((line) => line.startsWith("- ")).length;
  return {
    bodyWithoutSources: body.slice(0, headingIndex).trimEnd(),
    sourceCount,
    sourcesMarkdown: sources,
  };
};

export type ChatExportDownload = {
  downloadUrl: string;
  fileName: string;
  /** ISO-8601 instant the presigned URL stops working. */
  expiresAt: string;
};

type BuildChatExportDownloadArgs = {
  downloadUrl: string;
  fileName: string;
  expiresInSeconds: number;
  now: Date;
};

/** Shape the export response: the presigned URL plus its absolute expiry, so
 *  the client can show/refresh a deadline instead of a relative TTL. */
export const buildChatExportDownload = ({
  downloadUrl,
  fileName,
  expiresInSeconds,
  now,
}: BuildChatExportDownloadArgs): ChatExportDownload => ({
  downloadUrl,
  fileName,
  expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
});
