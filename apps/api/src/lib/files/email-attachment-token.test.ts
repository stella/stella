import { describe, expect, test } from "bun:test";

import {
  createEmailAttachmentDescriptor,
  findEmailAttachmentIndex,
} from "./email-attachment-token";

const source = {
  secret: "test-secret",
  sourceFileId: "file-1",
  sourceVersionId: "version-1",
};

describe("email attachment descriptors", () => {
  test("are stable opaque handles bound to the source version", () => {
    const descriptor = createEmailAttachmentDescriptor({
      ...source,
      attachmentIndex: 2,
    });

    expect(descriptor).toBe(
      createEmailAttachmentDescriptor({ ...source, attachmentIndex: 2 }),
    );
    expect(descriptor).not.toContain(source.sourceFileId);
    expect(findEmailAttachmentIndex({ ...source, descriptor })).toBe(2);
    expect(
      findEmailAttachmentIndex({
        ...source,
        descriptor,
        sourceVersionId: "version-2",
      }),
    ).toBeNull();
  });

  test("rejects malformed or out-of-range handles", () => {
    expect(
      findEmailAttachmentIndex({ ...source, descriptor: "ea1.invalid" }),
    ).toBeNull();
    expect(() =>
      createEmailAttachmentDescriptor({
        ...source,
        attachmentIndex: 100,
      }),
    ).toThrow();
  });
});
