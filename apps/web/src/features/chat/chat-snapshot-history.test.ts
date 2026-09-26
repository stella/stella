import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { keepPostedMessages } from "@/features/chat/chat-snapshot-history";

const message = (id: string, role: "assistant" | "user"): UIMessage => ({
  id,
  parts: [],
  role,
});

/** The page's messages, and which of them the server's snapshot keeps, in
 *  order, followed by the run's new messages. */
const caseArb = fc
  .tuple(
    fc.array(fc.boolean(), { maxLength: 8, minLength: 1 }),
    fc.nat({ max: 2 }),
  )
  .map(([kept, added]) => {
    const posted = kept.map((_, index) =>
      message(
        `posted-${String(index)}`,
        index % 2 === 0 ? "user" : "assistant",
      ),
    );
    // The page's latest message is the one the run answers: always kept.
    const snapshot = [
      ...posted.filter(
        (_, index) => kept[index] === true || index === posted.length - 1,
      ),
      ...Array.from({ length: added }, (_, index) =>
        message(`added-${String(index)}`, "assistant"),
      ),
    ].map(({ id, parts, role }) => ({ content: "", id, parts, role }));
    return { posted, snapshot };
  });

describe("keepPostedMessages", () => {
  test("keeps every posted message, in the page's order, ahead of the run's", () => {
    fc.assert(
      fc.property(caseArb, ({ posted, snapshot }) => {
        const ids = keepPostedMessages(posted, snapshot).map(({ id }) => id);
        expect(ids).toEqual([
          ...posted.map(({ id }) => id),
          ...snapshot
            .map(({ id }) => id)
            .filter((id) => id.startsWith("added-")),
        ]);
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("returns a snapshot that holds every posted message unchanged", () => {
    const posted = [message("a", "user"), message("b", "assistant")];
    const snapshot = posted.map(({ id, parts, role }) => ({
      content: "",
      id,
      parts,
      role,
    }));
    expect(keepPostedMessages(posted, snapshot)).toEqual(snapshot);
  });
});
