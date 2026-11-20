import type { ConditionNode } from "@stll/conditions";
import { FaceLabelPending } from "@stll/ui/control-face";
import { SlidersHorizontalIcon } from "@stll/ui/icons";
import {
  ViewFilterButtonFace,
  ViewFilterChipFace,
} from "@stll/ui/view-toolbar-shell";

import { PendingText } from "@/components/pending-text";

/** A filter chip's field name, beside its glyph. */
export const FILTER_CHIP_FIELD_CLASS = "text-foreground";

/** A filter chip's operator and value, after the field. */
export const FILTER_CHIP_SUMMARY_CLASS = "text-muted-foreground";

/** The glyph on an advanced (grouped) filter's chip. */
export const ADVANCED_FILTER_ICON_CLASS = "size-3.5";

/**
 * `FilterChips` (./view-toolbar-filters.tsx) before the properties are read:
 * a chip per filter the view carries, with bars where the field, its glyph
 * and the summary go (they name properties), then the "add a filter" button.
 */
export const FilterChipsFace = ({
  filters,
}: {
  filters: readonly ConditionNode[];
}) => (
  <>
    {filters.map((node, index) => (
      // oxlint-disable-next-line react/no-array-index-key -- ConditionNode has no stable id, and the face keeps no state per chip; the loaded chips key by index the same way.
      <ViewFilterChipFace key={index}>
        {node.type === "group" ? (
          <>
            <SlidersHorizontalIcon className={ADVANCED_FILTER_ICON_CLASS} />
            <span className={FILTER_CHIP_FIELD_CLASS}>
              <PendingText barClassName="w-14" id="common.advanced" />
            </span>
            <span className={FILTER_CHIP_SUMMARY_CLASS}>
              <FaceLabelPending className="w-10" />
            </span>
          </>
        ) : (
          <>
            <FaceLabelPending className="w-3.5" />
            <span className={FILTER_CHIP_FIELD_CLASS}>
              <FaceLabelPending className="w-14" />
            </span>
            <span className={FILTER_CHIP_SUMMARY_CLASS}>
              <FaceLabelPending className="w-12" />
            </span>
          </>
        )}
      </ViewFilterChipFace>
    ))}
    <ViewFilterButtonFace />
  </>
);
