import { panic } from "better-result";
import type { InferOutput } from "valibot";

import type { asicPreviewSchema } from "@stll/api-contract/asic";

type Preview = InferOutput<typeof asicPreviewSchema>;
/** What the text shows of a member: its name and its reading. */
type MemberReading = Pick<
  Preview["members"][number],
  "fileName" | "status" | "text"
>;

const memberText = ({ status, text }: MemberReading): string => {
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

export const asicDocumentText = ({
  members,
}: {
  members: readonly MemberReading[];
}): string =>
  [
    "ASiC signature container. Signatures are unverified.",
    ...members.map(
      (member) => `Attachment: ${member.fileName}\n${memberText(member)}`,
    ),
  ].join("\n\n");
