import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { ArrowUpDownIcon, XIcon } from "@stll/ui/icons";

import {
  SORT_CHIP_CLASS,
  SORT_CHIP_TOGGLE,
  SORT_DIRECTION_CLASS,
  SORT_ICON_BUTTON,
} from "./sort-chip-classes";

/*
 * The faces of the sort chips (./sorts.tsx) a loading view draws before the
 * page mounts: no menu, no Base UI, so a pending view the server paints
 * before the providers mount can draw them.
 */

type SortChipsFaceProps = {
  /** The view's sorts, in order; their names wait on the properties. */
  sorts: readonly { propertyId: string }[];
};

/**
 * `SortChips` before the properties are read: one chip per sort, with bars
 * where the property's name and the direction go, then "add a sort".
 */
export const SortChipsFace = ({ sorts }: SortChipsFaceProps) => (
  <>
    {sorts.map((sort) => (
      <span
        aria-hidden="true"
        className={SORT_CHIP_CLASS}
        data-slot="sort-chip-face"
        key={sort.propertyId}
      >
        <ButtonFace
          size={SORT_CHIP_TOGGLE.size}
          variant={SORT_CHIP_TOGGLE.variant}
        >
          <FaceLabelPending className="w-14" />
          <span className={SORT_DIRECTION_CLASS}>
            <FaceLabelPending className="w-8" />
          </span>
        </ButtonFace>
        <ButtonFace
          size={SORT_ICON_BUTTON.size}
          variant={SORT_ICON_BUTTON.variant}
        >
          <XIcon />
        </ButtonFace>
      </span>
    ))}
    <ButtonFace size={SORT_ICON_BUTTON.size} variant={SORT_ICON_BUTTON.variant}>
      <ArrowUpDownIcon />
    </ButtonFace>
  </>
);
