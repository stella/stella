import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stll/ui/accordion";

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
        <AccordionTrigger aria-label={summary} size="compact">
          <span className="min-w-0 truncate">{summary}</span>
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
