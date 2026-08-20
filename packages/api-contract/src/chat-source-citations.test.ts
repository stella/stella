import { describe, expect, test } from "bun:test";

import {
  parseCanonicalChatSourceCitationHref,
  replaceCanonicalChatSourceCitationHrefs,
  toChatSourceCitationHref,
} from "./chat-source-citations";
import { toSafeId } from "./safe-id";

const identity = {
  workspaceId: toSafeId<"workspace">("matter:eu-west-1"),
  entityId: toSafeId<"entity">("document:facility-agreement"),
  fieldId: toSafeId<"field">("field:executed-copy"),
};

describe("chat source citation hrefs", () => {
  test("round trips PDF and DOCX locators with opaque identifiers", () => {
    const targets = [
      {
        ...identity,
        type: "docx-folio" as const,
        blockId: "seq-0042",
        text: "The facility expires on 31 December 2030.",
      },
      {
        ...identity,
        type: "pdf-bates" as const,
        pageNumber: 7,
        bates: "F0-0007",
      },
    ];

    for (const target of targets) {
      const href = toChatSourceCitationHref(target);
      expect(parseCanonicalChatSourceCitationHref(href)).toEqual(target);
    }
  });

  test("rewrites only complete canonical citations", () => {
    const href = toChatSourceCitationHref({
      ...identity,
      type: "pdf-bates",
      pageNumber: 3,
      bates: "F1-0003",
    });

    expect(
      replaceCanonicalChatSourceCitationHrefs(
        `See [the repayment date](${href}).`,
        (target) => `#source-ref=${target.type}`,
      ),
    ).toBe("See [the repayment date](#source-ref=pdf-bates).");
    expect(parseCanonicalChatSourceCitationHref(`${href}:extra`)).toBeNull();
    expect(
      parseCanonicalChatSourceCitationHref(
        "#stella-source=pdf-bates:workspace:entity:field:0:F0-0000",
      ),
    ).toBeNull();
  });
});
