import { statuteDisplayLabel } from "@stll/api-contract/statute-display-label";
import { BidiText } from "@stll/ui/bidi-text";

type StatuteDisplayLabelProps = {
  statute: Parameters<typeof statuteDisplayLabel>[0];
};

/** Only the subject is clamped; the act's identity can wrap at narrow widths. */
export const StatuteDisplayLabel = ({ statute }: StatuteDisplayLabelProps) => {
  const label = statuteDisplayLabel(statute);
  const separator =
    label.identity === null || label.subject === null
      ? ""
      : label.text.slice(
          label.identity.length,
          label.text.length - label.subject.length,
        );
  return (
    <BidiText as="span" className="block min-w-0" title={label.text}>
      {label.identity !== null && (
        <span className="block whitespace-normal">
          <span>{label.identity}</span>
          {separator}
        </span>
      )}
      {label.subject !== null && (
        <span className="line-clamp-2 whitespace-normal">{label.subject}</span>
      )}
    </BidiText>
  );
};
