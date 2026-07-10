import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";

import { sanitizeFeedbackText } from "@/api/mcp/feedback-sanitize";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  enumProp,
  stringProp,
  textResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";

const FEEDBACK_KINDS = ["bug", "feature_request", "docs", "other"] as const;
type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

const FEEDBACK_CHANNELS = ["github"] as const;

const MAX_FEEDBACK_TITLE_CHARS = 200;
const MAX_FEEDBACK_BODY_CHARS = 8000;

const GITHUB_REPO = "stella/stella";
const GITHUB_ISSUE_LABEL = "agent-feedback";
const GITHUB_NEW_ISSUE_URL = `https://github.com/${GITHUB_REPO}/issues/new`;
// A conservative cap: browsers and servers accept much longer, but keeping the
// prefilled URL small avoids client-side truncation surprises. The full
// sanitized body is always returned separately, so nothing is lost.
const MAX_GITHUB_ISSUE_URL_CHARS = 7500;
const GITHUB_BODY_TRUNCATION_MARKER =
  "\n\n[body truncated — paste the rest manually]";
const HIGH_SURROGATE_START = 55_296;
const HIGH_SURROGATE_END = 56_319;

export const FEEDBACK_TOOL_DEFINITIONS = [
  {
    description:
      "File a bug, feature request, or docs issue with the stella maintainers. " +
      "Requires explicit human approval; the tool never publishes anything on " +
      "its own. It returns a prefilled " +
      "new-issue URL and a gh command the human opens and submits under their " +
      "own GitHub account. All content is sanitized server-side (emails, ids, secrets, " +
      "URLs, IPs are redacted). Never include tenant data, client or matter " +
      "names, ids, or secrets; describe the problem, reproduction steps, and " +
      "expected vs actual result.",
    inputSchema: {
      type: "object",
      properties: {
        kind: enumProp(
          "Feedback category: bug, feature_request, docs, or other",
          FEEDBACK_KINDS,
        ),
        title: stringProp(
          "Short one-line summary of the issue; no tenant data, ids, or secrets",
          { maxLength: MAX_FEEDBACK_TITLE_CHARS },
        ),
        body: stringProp(
          "Markdown details: reproduction steps, expected vs actual behavior, " +
            "environment. Never include tenant data, client or matter names, " +
            "ids, or secrets; they are redacted server-side.",
          { maxLength: MAX_FEEDBACK_BODY_CHARS },
        ),
        channel: enumProp(
          "Delivery channel. github returns a prefilled issue URL the human " +
            "submits under their own GitHub account.",
          FEEDBACK_CHANNELS,
        ),
      },
      required: ["kind", "title", "body"],
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "send_feedback",
    scope: "stella:feedback",
  },
] as const satisfies readonly McpToolDefinition[];

const feedbackArgsSchema = v.strictObject({
  kind: v.picklist(FEEDBACK_KINDS),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(MAX_FEEDBACK_TITLE_CHARS),
  ),
  body: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_FEEDBACK_BODY_CHARS),
  ),
  channel: v.optional(v.picklist(FEEDBACK_CHANNELS), "github"),
});

/**
 * Sanitized body plus a provenance footer. No user/org identifiers appear
 * anywhere in the published body.
 */
const composeFeedbackBody = ({
  body,
  kind,
}: {
  body: string;
  kind: FeedbackKind;
}): string =>
  `${body}\n\n---\n_Filed via stella send_feedback (agent-assisted, sanitized). Kind: ${kind}._`;

const buildGithubIssueUrl = ({
  body,
  title,
}: {
  body: string;
  title: string;
}): string => {
  const params = new URLSearchParams({
    title,
    body,
    labels: GITHUB_ISSUE_LABEL,
  });
  return `${GITHUB_NEW_ISSUE_URL}?${params.toString()}`;
};

export const sliceWithoutDanglingHighSurrogate = (
  value: string,
  end: number,
): string => {
  const sliced = value.slice(0, end);
  const last = sliced.codePointAt(sliced.length - 1);
  return last !== undefined &&
    last >= HIGH_SURROGATE_START &&
    last <= HIGH_SURROGATE_END
    ? sliced.slice(0, -1)
    : sliced;
};

/**
 * Prefilled issue URL bounded to `MAX_GITHUB_ISSUE_URL_CHARS`. When the full
 * body overflows, the URL carries a truncated body with a paste-the-rest
 * marker; the caller still returns the full sanitized body separately.
 */
const buildBoundedGithubIssueUrl = ({
  composedBody,
  title,
}: {
  composedBody: string;
  title: string;
}): string => {
  const full = buildGithubIssueUrl({ body: composedBody, title });
  if (full.length <= MAX_GITHUB_ISSUE_URL_CHARS) {
    return full;
  }
  for (let keep = composedBody.length; keep > 0; keep -= 128) {
    const candidate = buildGithubIssueUrl({
      body:
        sliceWithoutDanglingHighSurrogate(composedBody, keep) +
        GITHUB_BODY_TRUNCATION_MARKER,
      title,
    });
    if (candidate.length <= MAX_GITHUB_ISSUE_URL_CHARS) {
      return candidate;
    }
  }
  // Even an empty body overflows (an outsized title): fall back to marker-only.
  return buildGithubIssueUrl({ body: GITHUB_BODY_TRUNCATION_MARKER, title });
};

/** POSIX single-quote escaping so the gh command is safe to paste verbatim. */
const shellSingleQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const buildGithubFeedbackResult = ({
  composedBody,
  redactions,
  sanitizedTitle,
}: {
  composedBody: string;
  redactions: number;
  sanitizedTitle: string;
}): CallToolResult => {
  const issueUrl = buildBoundedGithubIssueUrl({
    composedBody,
    title: sanitizedTitle,
  });
  const ghCliCommand =
    `gh issue create --repo ${GITHUB_REPO} --label ${GITHUB_ISSUE_LABEL} ` +
    `--title ${shellSingleQuote(sanitizedTitle)} --body ${shellSingleQuote(composedBody)}`;

  return textResult({
    channel: "github",
    sanitized_title: sanitizedTitle,
    sanitized_body: composedBody,
    redactions,
    issue_url: issueUrl,
    gh_cli_command: ghCliCommand,
    next_step:
      "Show sanitized content and issue_url to the human. Nothing is published " +
      "until they open the URL (or run the gh command) and submit under their " +
      "own GitHub account. For code contributions, fork github.com/stella/stella " +
      "and open a PR (see CONTRIBUTING.md).",
  });
};

const handleSendFeedbackTool: McpToolHandler = async ({ args }) => {
  const parsed = await Promise.resolve(v.safeParse(feedbackArgsSchema, args));
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message:
        parsed.issues.at(0)?.message ?? "Invalid send_feedback arguments",
      hint:
        `Provide kind (one of ${FEEDBACK_KINDS.join(", ")}), a non-empty title ` +
        `(<= ${MAX_FEEDBACK_TITLE_CHARS} chars), and a non-empty body ` +
        `(<= ${MAX_FEEDBACK_BODY_CHARS} chars).`,
    });
  }
  const { body, kind, title } = parsed.output;
  const sanitizedTitlePass = sanitizeFeedbackText(title);
  const sanitizedBodyPass = sanitizeFeedbackText(body);

  return buildGithubFeedbackResult({
    composedBody: composeFeedbackBody({
      body: sanitizedBodyPass.text,
      kind,
    }),
    redactions: sanitizedTitlePass.redactions + sanitizedBodyPass.redactions,
    sanitizedTitle: sanitizedTitlePass.text,
  });
};

export const FEEDBACK_TOOL_HANDLERS = {
  send_feedback: handleSendFeedbackTool,
} satisfies Record<"send_feedback", McpToolHandler>;

export const FEEDBACK_TOOL_SET = defineMcpToolSet(
  FEEDBACK_TOOL_DEFINITIONS,
  FEEDBACK_TOOL_HANDLERS,
);
