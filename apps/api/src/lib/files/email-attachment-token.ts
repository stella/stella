import { createHmac } from "node:crypto";

/** Maximum descriptors exposed by one email preview. */
export const MAX_EMAIL_ATTACHMENT_DESCRIPTORS = 100;

const DESCRIPTOR_PREFIX = "ea1";

type EmailAttachmentDescriptorInput = {
  attachmentIndex: number;
  sourceFileId: string;
  sourceVersionId: string;
};

const descriptorMessage = ({
  attachmentIndex,
  sourceFileId,
  sourceVersionId,
}: EmailAttachmentDescriptorInput): string =>
  `${DESCRIPTOR_PREFIX}:${sourceFileId}:${sourceVersionId}:${String(attachmentIndex)}`;

/** Create a stable, opaque handle bound to one immutable email version. */
export const createEmailAttachmentDescriptor = ({
  attachmentIndex,
  sourceFileId,
  sourceVersionId,
  secret,
}: EmailAttachmentDescriptorInput & { secret: string }): string => {
  if (
    !Number.isInteger(attachmentIndex) ||
    attachmentIndex < 0 ||
    attachmentIndex >= MAX_EMAIL_ATTACHMENT_DESCRIPTORS
  ) {
    throw new RangeError("Email attachment index is out of bounds");
  }

  const digest = createHmac("sha256", secret)
    .update(
      descriptorMessage({ attachmentIndex, sourceFileId, sourceVersionId }),
    )
    .digest("base64url");
  return `${DESCRIPTOR_PREFIX}.${digest}`;
};

export const findEmailAttachmentIndex = ({
  descriptor,
  secret,
  sourceFileId,
  sourceVersionId,
}: {
  descriptor: string;
  secret: string;
  sourceFileId: string;
  sourceVersionId: string;
}): number | null => {
  if (!/^ea1\.[A-Za-z0-9_-]{43}$/u.test(descriptor)) {
    return null;
  }

  for (
    let attachmentIndex = 0;
    attachmentIndex < MAX_EMAIL_ATTACHMENT_DESCRIPTORS;
    attachmentIndex += 1
  ) {
    if (
      createEmailAttachmentDescriptor({
        attachmentIndex,
        secret,
        sourceFileId,
        sourceVersionId,
      }) === descriptor
    ) {
      return attachmentIndex;
    }
  }

  return null;
};
