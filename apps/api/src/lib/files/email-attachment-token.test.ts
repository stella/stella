import { describe, expect, test } from "bun:test";

import {
  createEmailAttachmentDescriptor,
  findEmailAttachmentIndex,
  MAX_EMAIL_ATTACHMENT_DESCRIPTORS,
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
    for (const attachmentIndex of [
      0,
      MAX_EMAIL_ATTACHMENT_DESCRIPTORS - 1,
      MAX_EMAIL_ATTACHMENT_DESCRIPTORS,
      10_000,
    ]) {
      const indexedDescriptor = createEmailAttachmentDescriptor({
        ...source,
        attachmentIndex,
      });
      expect(
        findEmailAttachmentIndex({ ...source, descriptor: indexedDescriptor }),
      ).toBe(attachmentIndex);
    }
    expect(
      findEmailAttachmentIndex({
        ...source,
        descriptor,
        sourceVersionId: "version-2",
      }),
    ).toBeNull();
    expect(
      findEmailAttachmentIndex({
        ...source,
        descriptor,
        sourceFileId: "file-2",
      }),
    ).toBeNull();
    expect(
      findEmailAttachmentIndex({
        ...source,
        descriptor,
        secret: "tampered-secret",
      }),
    ).toBeNull();
    expect(
      findEmailAttachmentIndex({
        ...source,
        descriptor: `${descriptor.slice(0, -1)}x`,
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
        attachmentIndex: -1,
      }),
    ).toThrow();
    expect(() =>
      createEmailAttachmentDescriptor({
        ...source,
        attachmentIndex: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });
});
