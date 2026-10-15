import { panic } from "better-result";

import type {
  OutboundActionPreview,
  OutboundEmailPreview,
} from "@stll/api-contract/outbound-action";
import { sha256Hex } from "@stll/sha256/bun";

const PREVIEW_HASH_DOMAIN = "stella:outbound-preview:v1";

type EmailRecipient = OutboundEmailPreview["to"][number];

const canonicalRecipient = ({ address, name }: EmailRecipient) => [
  address,
  name ?? null,
];

/**
 * A fixed-order array of every field the preview card shows, so equal
 * previews serialize identically whatever key order produced them.
 */
const canonicalPreview = (preview: OutboundActionPreview): unknown[] => {
  switch (preview.kind) {
    case "email.send":
      return [
        preview.kind,
        canonicalRecipient(preview.from),
        preview.to.map(canonicalRecipient),
        preview.cc.map(canonicalRecipient),
        preview.bcc.map(canonicalRecipient),
        preview.subject,
        preview.bodyText,
        preview.attachments.map(({ byteLength, fileName, sha256 }) => [
          fileName,
          byteLength,
          sha256,
        ]),
        preview.inReplyTo,
      ];
    default:
      preview.kind satisfies never;
      return panic("Unhandled outbound action kind");
  }
};

/**
 * SHA-256 hex over the canonical preview. A confirm carries the hash of the
 * preview the user was shown; any change to what would be sent changes it.
 */
export const outboundPreviewHash = (preview: OutboundActionPreview): string =>
  sha256Hex(
    `${PREVIEW_HASH_DOMAIN}\n${JSON.stringify(canonicalPreview(preview))}`,
  );
