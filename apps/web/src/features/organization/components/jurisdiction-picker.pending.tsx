import { FaceLabelPending, InputFace } from "@stll/ui/control-face";
import { SearchIcon } from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";

/*
 * The jurisdiction picker (`./jurisdiction-picker.tsx`) in a pending phase:
 * its search field and its list of countries. With no query the list holds
 * every country, so it always fills its box's full height; the face draws
 * that box at that height with country rows inside, and the list that loads
 * lands in it. The picker renders the same column and box classes.
 */

/** The picker's column: the search field over the list. */
export const JURISDICTION_PICKER_CLASS = "flex flex-col gap-4";

/** One country's row in the list. */
export const JURISDICTION_ROW_CLASS =
  "border-border/70 flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0";

/** More rows than the box shows, so it fills like the real list. */
const PENDING_COUNTRY_ROW_COUNT = 10;
const PENDING_COUNTRY_ROWS = Array.from(
  { length: PENDING_COUNTRY_ROW_COUNT },
  (_, index) => `country-${String(index)}`,
);

/** The picker before the page mounts: the field's face over a full list. */
export const JurisdictionPickerPending = () => (
  <div aria-hidden="true" className={JURISDICTION_PICKER_CLASS}>
    <InputFace icon={<SearchIcon />}>
      <PendingText
        barClassName="w-32"
        id="onboarding.jurisdictionSearchPlaceholder"
      />
    </InputFace>
    {/* The list's box at its full height (the live list fills it with
        every country), clipping the rows the live list scrolls to. */}
    <div className="border-border h-[310px] overflow-hidden rounded-lg border">
      {PENDING_COUNTRY_ROWS.map((key) => (
        <div className={JURISDICTION_ROW_CLASS} key={key}>
          {/* A `row` button's box: the selection ring, the name, the code. */}
          <span className="flex min-h-8 min-w-0 flex-1 items-center gap-2 px-2 py-1 pointer-coarse:min-h-11">
            <span className="border-border size-5 shrink-0 rounded-full border" />
            <span className="flex-1">
              <FaceLabelPending className="w-32" />
            </span>
            <FaceLabelPending className="w-5" />
          </span>
        </div>
      ))}
    </div>
  </div>
);
