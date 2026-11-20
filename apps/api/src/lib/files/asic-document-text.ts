import { panic } from "better-result";
import type { InferOutput } from "valibot";

import type { asicPreviewSchema } from "@stll/api-contract/asic";

type Preview = InferOutput<typeof asicPreviewSchema>;

const memberText = ({ status, text }: Preview["members"][number]): string => {
  switch (status) {
    case "readable":
      return text;
    case "truncated":
      return text
        ? `${text}\nAttachment text was truncated.`
        : "Attachment text was truncated.";
    case "unavailable":
      return "Attachment text unavailable.";
    default:
      status satisfies never;
      return panic("Unknown ASiC member text status");
  }
};

export const asicDocumentText = ({ members }: Preview): string =>
  [
    "ASiC signature container. Signatures are unverified.",
    ...members.map(
      (member) => `Attachment: ${member.fileName}\n${memberText(member)}`,
    ),
  ].join("\n\n");
