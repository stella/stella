import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  buildTemplateRevisionS3Key,
  buildTemplateS3Key,
  buildTemplateVersionS3Key,
} from "@/api/lib/templates/storage-keys";

const organizationId = toSafeId<"organization">(
  "6f1a3d2c-9b44-4e0f-8f2a-7c5d1e8b0a31",
);
const templateId = toSafeId<"template">("0c7e5b1a-2d43-4f9c-bb18-6a4e2f7d9c05");

describe("buildTemplateRevisionS3Key", () => {
  test("never lands on the key a re-embed reads from", () => {
    // The re-embed path reads the live object (or the current version's
    // snapshot) and stores the result under this key. Sharing a key with either
    // would make the write destructive, which is what the separate key exists
    // to prevent.
    const revisionKey = buildTemplateRevisionS3Key({
      contents: new Uint8Array([1, 2, 3]),
      organizationId,
      templateId,
      version: 3,
    });

    expect(revisionKey).not.toBe(
      buildTemplateS3Key(organizationId, templateId),
    );
    expect(revisionKey).not.toBe(
      buildTemplateVersionS3Key(organizationId, templateId, 3),
    );
  });

  test("addresses by content: same bytes reuse a key, changed bytes do not", () => {
    const keyFor = (contents: Uint8Array) =>
      buildTemplateRevisionS3Key({
        contents,
        organizationId,
        templateId,
        version: 3,
      });

    expect(keyFor(new Uint8Array([1, 2, 3]))).toBe(
      keyFor(new Uint8Array([1, 2, 3])),
    );
    expect(keyFor(new Uint8Array([1, 2, 3]))).not.toBe(
      keyFor(new Uint8Array([1, 2, 4])),
    );
  });

  test("keeps revisions of different versions apart", () => {
    const contents = new Uint8Array([1, 2, 3]);
    expect(
      buildTemplateRevisionS3Key({
        contents,
        organizationId,
        templateId,
        version: 3,
      }),
    ).not.toBe(
      buildTemplateRevisionS3Key({
        contents,
        organizationId,
        templateId,
        version: 4,
      }),
    );
  });
});
