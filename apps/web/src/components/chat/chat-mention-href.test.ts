import { describe, expect, test } from "bun:test";

import { parseStellaMentionHref } from "@/components/chat/chat-mention-href";

describe("chat mention hrefs", () => {
  test("recognizes stable entity hrefs used by clickable document mentions", () => {
    expect(
      parseStellaMentionHref(
        "#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34",
      ),
    ).toEqual({
      category: "entity",
      id: "0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34",
    });
  });

  test("does not treat request-local entity refs as stable mention hrefs", () => {
    expect(parseStellaMentionHref("#stella-entity-ref=ent_1")).toBeNull();
  });
});
