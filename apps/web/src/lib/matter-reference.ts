import {
  matchesMatterReferencePattern,
  renderMatterReferencePattern,
} from "@stll/api-contract";

export {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@stll/api-contract";

export const matchesPattern = matchesMatterReferencePattern;

export const previewReference = ({
  pattern,
  padding,
  now = new Date(),
}: {
  pattern: string;
  padding: number;
  now?: Date;
}): string => {
  const paddedSeq = "1".padStart(padding, "0");
  return renderMatterReferencePattern({ now, pattern, sequence: paddedSeq });
};
