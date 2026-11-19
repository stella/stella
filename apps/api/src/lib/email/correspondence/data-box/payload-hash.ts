import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type { ParsedDataBoxMessage } from "./zfo";

/** Delivery state and seal may change between exports of the same filed message. */
export const dataBoxPayloadIdentity = ({
  annotation,
  envelope,
  files,
}: Pick<ParsedDataBoxMessage, "annotation" | "envelope" | "files">) => {
  const members = files.map(({ fileName, mimeType, bytes }) => ({
    fileName,
    mimeType,
    sha256Hex: hashSha256Hex(bytes),
  }));
  const contentHash = hashSha256Hex(
    JSON.stringify([
      annotation,
      {
        messageId: envelope.messageId,
        messageType: envelope.messageType,
        sender: envelope.sender,
        recipient: envelope.recipient,
        toHands: envelope.toHands,
        personalDelivery: envelope.personalDelivery,
        substituteDelivery: envelope.substituteDelivery,
      } satisfies Omit<
        typeof envelope,
        "seal" | "deliveredAt" | "acceptedAt" | "status"
      >,
      members.map(({ fileName, mimeType, sha256Hex }) => [
        fileName,
        mimeType,
        sha256Hex,
      ]),
    ]),
  );
  return { contentHash, files: members };
};
