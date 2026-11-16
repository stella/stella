import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stll/ui/accordion";
import { TruncatedText } from "@stll/ui/truncated-text";

import { searchNoticeDetails } from "./notice.logic";
import type { AppSearchWarning } from "./notice.logic";

export const AppNotice = ({ details }: { details: readonly string[] }) => {
  if (details.length === 0) {
    return null;
  }
  const summary = details.join(" · ");
  return (
    <Accordion
      className="text-muted-foreground min-w-0 text-xs"
      data-app-notice
    >
      <AccordionItem className="border-0" value="notice">
        <AccordionTrigger
          aria-label={summary}
          className="h-6 items-center py-0"
          size="compact"
        >
          <TruncatedText>{summary}</TruncatedText>
        </AccordionTrigger>
        <AccordionPanel size="compact">
          <ul className="list-disc space-y-1 ps-4">
            {details.map((detail) => (
              <li key={detail} className="break-words">
                {detail}
              </li>
            ))}
          </ul>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
};

export const SearchNotice = ({
  warnings,
}: {
  warnings: readonly AppSearchWarning[];
}) => <AppNotice details={searchNoticeDetails(warnings)} />;
