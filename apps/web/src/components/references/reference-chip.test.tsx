import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import messages from "@/i18n/langs/en.json";
import { ChatThreadTestRouter } from "@/lib/chat-thread-test-router";

const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] = previousApiUrl ?? "https://api.example.test";

const { StreamdownMentionLink } =
  await import("@/components/chat/streamdown-mention-link");
const { ReferenceChip, ReferenceRenderScope } =
  await import("@/components/references/reference-chip");
const { seedReferenceHints } =
  await import("@/components/references/reference-hints");
const { mentionAttrsToHref, mentionTagAttrs, referenceFromMentionAttrs } =
  await import("@/components/references/reference.logic");

afterAll(() => {
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
    return;
  }
  process.env["VITE_API_URL"] = previousApiUrl;
});

const MATTER_ID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const TASK_ID = "c09ec856-d945-5ecc-82e3-bb5382165f34";
const LABEL = "Call the counterparty";

/** The task as the composer inserted it (a drill-down from the thread's own
 * matter, so the persisted href carries no matter). */
const COMPOSER_ATTRS = {
  id: TASK_ID,
  label: LABEL,
  category: "entity",
  kind: "task",
  mimeType: null,
  matterId: MATTER_ID,
  sourceWorkspaceId: null,
};

const render = (queryClient: QueryClient, children: ReactNode) =>
  renderToStaticMarkup(
    <ChatThreadTestRouter>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ReferenceRenderScope workspaceId={MATTER_ID}>
            {children}
          </ReferenceRenderScope>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );

/** The pill's content (glyph and label), without the element that differs
 * between a clickable and a static chip. */
const chipContent = (html: string): string => {
  const match =
    /^<(?:span|button)[^>]*data-reference-type="entity"[^>]*>(?<inner>.*)<\/(?:span|button)>$/su.exec(
      html,
    );
  if (match?.groups?.["inner"] === undefined) {
    throw new Error(`Not a reference chip: ${html}`);
  }
  return match.groups["inner"];
};

const sessionClient = () => {
  const queryClient = new QueryClient();
  // What the composer's submit records before the message leaves.
  seedReferenceHints(queryClient, {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "mention", attrs: COMPOSER_ATTRS }],
      },
    ],
  });
  return queryClient;
};

const tagAttr = (name: string): string | null =>
  ({
    "data-id": TASK_ID,
    "data-label": LABEL,
    "data-category": "entity",
    "data-kind": "task",
    "data-matter-id": MATTER_ID,
  })[name] ?? null;

describe("a mention chip across a message's life", () => {
  test("looks the same in the composer, just sent, streamed back, and reloaded", () => {
    const queryClient = sessionClient();
    const composerReference = referenceFromMentionAttrs(COMPOSER_ATTRS);
    if (composerReference === null) {
      throw new Error("Expected a composer reference");
    }
    const optimisticHref = mentionAttrsToHref(mentionTagAttrs(tagAttr));
    if (optimisticHref === null) {
      throw new Error("Expected an optimistic href");
    }
    const persistedHref = `#stella-entity=${TASK_ID}`;

    const composer = render(
      queryClient,
      <ReferenceChip interactive={false} reference={composerReference} />,
    );
    const justSent = render(
      queryClient,
      <StreamdownMentionLink href={optimisticHref} interactive={false}>
        {LABEL}
      </StreamdownMentionLink>,
    );
    const reloadedMessage = render(
      queryClient,
      <StreamdownMentionLink href={persistedHref} interactive={false}>
        {LABEL}
      </StreamdownMentionLink>,
    );
    const streamedAnswer = render(
      queryClient,
      <StreamdownMentionLink
        href={`#stella-entity=${MATTER_ID}:${TASK_ID}`}
        interactive
      >
        {LABEL}
      </StreamdownMentionLink>,
    );

    expect(optimisticHref).toBe(persistedHref);
    const expected = chipContent(composer);
    expect(chipContent(justSent)).toBe(expected);
    expect(chipContent(reloadedMessage)).toBe(expected);
    expect(chipContent(streamedAnswer)).toBe(expected);
    // The task glyph, not the loading placeholder.
    expect(expected).toContain("lucide-list-todo");
    expect(expected).not.toContain("lucide-circle-dashed");
    expect(expected).toContain(LABEL);
  });

  test("without the session's hint, a persisted mention waits on the entity read", () => {
    const html = render(
      new QueryClient(),
      <StreamdownMentionLink
        href={`#stella-entity=${MATTER_ID}:${TASK_ID}`}
        interactive={false}
      >
        {LABEL}
      </StreamdownMentionLink>,
    );
    expect(chipContent(html)).toContain('data-slot="loader"');
  });

  test("an unresolvable mention renders as its plain label", () => {
    const html = render(
      new QueryClient(),
      <StreamdownMentionLink href="#stella-unresolved-ref" interactive>
        {LABEL}
      </StreamdownMentionLink>,
    );
    expect(html).toBe(`<span>${LABEL}</span>`);
  });
});
