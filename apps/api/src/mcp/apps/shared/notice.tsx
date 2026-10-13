import { useTranslations } from "use-intl";

import { ChevronRightIcon } from "@stll/ui/icons";

import { searchNoticeDetails } from "./notice.logic";
import type { AppSearchWarning } from "./notice.logic";

export const AppNotice = ({ details }: { details: readonly string[] }) => {
  if (details.length === 0) {
    return null;
  }
  return (
    <details
      className="group text-muted-foreground min-w-0 text-xs"
      data-app-notice
    >
      <summary className="focus-visible:ring-ring flex min-w-0 cursor-pointer items-center gap-1 rounded-sm outline-none focus-visible:ring-2">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3 shrink-0 group-open:rotate-90 rtl:rotate-180"
        />
        <span className="min-w-0 truncate">{details.join(" · ")}</span>
      </summary>
      <ul className="mt-2 list-disc space-y-1 ps-4">
        {details.map((detail) => (
          <li key={detail} className="break-words">
            {detail}
          </li>
        ))}
      </ul>
    </details>
  );
};

export const SearchNotice = ({
  warnings,
}: {
  warnings: readonly AppSearchWarning[];
}) => {
  const t = useTranslations();
  return <AppNotice details={searchNoticeDetails(warnings, t)} />;
};
