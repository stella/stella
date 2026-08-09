import { createHmac, timingSafeEqual } from "node:crypto";

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
  if (!Number.isSafeInteger(attachmentIndex) || attachmentIndex < 0) {
    throw new RangeError("Email attachment index is out of bounds");
  }

  const digest = createHmac("sha256", secret)
    .update(
      descriptorMessage({ attachmentIndex, sourceFileId, sourceVersionId }),
    )
    .digest("base64url");
  return `${DESCRIPTOR_PREFIX}.${String(attachmentIndex)}.${digest}`;
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
  const match = /^ea1\.([0-9]{1,16})\.[A-Za-z0-9_-]{43}$/u.exec(descriptor);
  const attachmentIndexText = match?.at(1);
  if (!attachmentIndexText) {
    return null;
  }
  const attachmentIndex = Number(attachmentIndexText);
  if (
    !Number.isSafeInteger(attachmentIndex) ||
    String(attachmentIndex) !== attachmentIndexText
  ) {
    return null;
  }
  const expected = createEmailAttachmentDescriptor({
    attachmentIndex,
    secret,
    sourceFileId,
    sourceVersionId,
  });
  return timingSafeEqual(Buffer.from(descriptor), Buffer.from(expected))
    ? attachmentIndex
    : null;
};
