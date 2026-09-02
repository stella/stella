import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";

type IdentifierExamplesProps = {
  examples: readonly string[];
  /** What the chips are introduced as; the jurisdiction when the page shows several. */
  label?: string | undefined;
  onExampleSelect: (example: string) => void;
};

/**
 * What an identifier looks like here, as chips under the box that run the
 * same entry the box would. A reader who has never typed a docket number
 * learns the shape by pressing one.
 */
export const IdentifierExamples = ({
  examples,
  label,
  onExampleSelect,
}: IdentifierExamplesProps) => {
  const t = useTranslations();

  if (examples.length === 0) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground text-xs">
        {label ?? t("lawHome.tryIdentifier")}
      </span>
      {examples.map((example) => (
        <Button
          className="text-muted-foreground hover:text-foreground h-6 px-1.5 text-xs font-normal"
          key={example}
          onClick={() => onExampleSelect(example)}
          size="sm"
          type="button"
          variant="outline"
        >
          <BidiText as="span">{example}</BidiText>
        </Button>
      ))}
    </div>
  );
};
