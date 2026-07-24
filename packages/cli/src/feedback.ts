import { parseArgs } from "node:util";

import {
  FEEDBACK_KINDS,
  MAX_FEEDBACK_BODY_CHARS,
  MAX_FEEDBACK_TITLE_CHARS,
  buildFeedbackSubmission,
  type FeedbackKind,
} from "@stll/anonymize/feedback";

import { UsageError } from "./args";

export const FEEDBACK_HELP = `Usage: anonymize feedback [options] [body ...]

Report a bug, feature request, or docs issue to the stella-anonymize
maintainers. Your title and body are sanitized locally (emails, ids,
secrets, URLs, and IPs are redacted); the command prints a prefilled
GitHub issue URL and a gh command that you open and submit under your
own account. It makes no network calls and submits nothing on its own.

Never include document text, client names, ids, or secrets; describe
the problem, the steps to reproduce, and expected vs actual result.

Options:
  --kind <kind>    bug | feature_request | docs | other (default: bug)
  --title <text>   Short one-line summary (required)
  --body <text>    Details; if omitted, the positional args or stdin are used
  --json           Emit the sanitized submission as JSON
  -h, --help       Print this help
`;

const isFeedbackKind = (value: string): value is FeedbackKind =>
  (FEEDBACK_KINDS as readonly string[]).includes(value);

type FeedbackCommandOptions = {
  argv: readonly string[];
  readStdin: () => Promise<string>;
  write: (text: string) => void;
};

const renderHuman = (
  submission: ReturnType<typeof buildFeedbackSubmission>,
): string =>
  [
    `Sanitized ${submission.redactions} item(s) from your feedback. Nothing was sent.`,
    "",
    "Title:",
    submission.title,
    "",
    "Body:",
    submission.sanitizedBody,
    "",
    "Open this URL to submit the issue under your own GitHub account:",
    submission.issueUrl,
    "",
    "Or run:",
    submission.ghCommand,
    "",
  ].join("\n");

/** Parse the feedback flags, rethrowing parse errors as usage errors (exit 2). */
const parseFeedbackArgs = (argv: readonly string[]) => {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        kind: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
};

export const runFeedbackCommand = async ({
  argv,
  readStdin,
  write,
}: FeedbackCommandOptions): Promise<void> => {
  const { values, positionals } = parseFeedbackArgs(argv);
  if (values.help === true) {
    write(FEEDBACK_HELP);
    return;
  }
  const kind = values.kind ?? "bug";
  if (!isFeedbackKind(kind)) {
    throw new UsageError(
      `unknown feedback kind "${kind}" (expected ${FEEDBACK_KINDS.join(", ")})`,
    );
  }
  const title = values.title?.trim() ?? "";
  if (title.length === 0) {
    throw new UsageError("feedback requires --title <text>");
  }
  if (title.length > MAX_FEEDBACK_TITLE_CHARS) {
    throw new UsageError(
      `--title must be at most ${MAX_FEEDBACK_TITLE_CHARS} characters`,
    );
  }
  const inlineBody = (
    values.body ?? (positionals.length > 0 ? positionals.join(" ") : undefined)
  )?.trim();
  const body =
    inlineBody !== undefined && inlineBody.length > 0
      ? inlineBody
      : (await readStdin()).trim();
  if (body.length === 0) {
    throw new UsageError(
      "feedback requires a body (--body <text>, positional text, or stdin)",
    );
  }
  if (body.length > MAX_FEEDBACK_BODY_CHARS) {
    throw new UsageError(
      `feedback body must be at most ${MAX_FEEDBACK_BODY_CHARS} characters`,
    );
  }
  const submission = buildFeedbackSubmission({ kind, title, body });
  if (values.json === true) {
    write(`${JSON.stringify({ channel: "github", ...submission }, null, 2)}\n`);
    return;
  }
  write(renderHuman(submission));
};
