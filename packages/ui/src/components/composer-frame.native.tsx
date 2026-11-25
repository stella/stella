import type { ComponentType, PropsWithChildren } from "react";

import type { LayoutChangeEvent, ViewProps } from "react-native";
import { useWindowDimensions, View } from "react-native";

import { cn } from "../lib/utils";
import type {
  ComposerFrameContract,
  ComposerLayout,
  ComposerRing,
} from "./composer-frame.shared";
import { useComposerLayout } from "./composer-layout";
import {
  COMPOSER_BOX_CLASS,
  COMPOSER_NATIVE_LINE_HEIGHT,
  COMPOSER_TEXT_REGION_MAX_HEIGHT_CLASS,
} from "./composer-tokens";

/**
 * The row the text sits in. In the bar it holds the controls too: 54pt, a
 * 42pt text line (a 24pt line, 9pt above and below) inside 6pt of inset.
 * Stacked it is a column: the text over the control row.
 */
const COMPOSER_ROW_CLASS = {
  bar: "min-h-[54px] flex-row items-end gap-2 px-2 py-1.5",
  stacked: "pt-1.5",
} as const satisfies Record<ComposerLayout, string>;

/**
 * The text cell. Its first line sits 15pt below the box's top in both
 * layouts, so the switch moves the text sideways only. Stacked it spans the
 * box.
 */
const COMPOSER_TEXT_CELL_CLASS = {
  bar: "min-w-0 flex-1 py-2.25",
  stacked: "px-3.5 pt-2.25 pb-1",
} as const satisfies Record<ComposerLayout, string>;

/** The large box's three-line height while empty. */
const COMPOSER_LARGE_TEXT_CLASS = "min-h-18";

/** A control group in the bar: one text line tall, so its controls centre
 *  on the line. */
const COMPOSER_BAR_SEAT_CLASS = "h-10.5 flex-row items-center gap-2";

/** The stacked control row: leading at the start, trailing at the end. */
const COMPOSER_CONTROL_ROW_CLASS =
  "flex-row items-center justify-between gap-2 px-2 pb-1.5";

const COMPOSER_CONTROL_GROUP_CLASS = "flex-row items-center gap-2";

const COMPOSER_RING_CLASS = {
  none: "border-border",
  // A phone shows where typing goes by its keyboard and caret; its message
  // fields draw no focus ring.
  focus: "border-border",
  anonymized: "border-info/40",
  attention: "border-primary",
} as const satisfies Record<ComposerRing, string>;

type ComposerFrameProps = Omit<ViewProps, "children"> &
  ComposerFrameContract & {
    /**
     * Draws the box in place of the bordered one, such as the app's Liquid
     * Glass capsule on iOS (a platform effect this package does not depend
     * on). The frame lays its content out the same inside it; `ring` paints
     * only the bordered box.
     */
    Box?: ComponentType<PropsWithChildren> | undefined;
  };

/**
 * The web's `ComposerFrame` (./composer-frame.tsx) on a phone: the one
 * composer box, with the same slots and the same rule for its two layouts
 * (./composer-layout.ts). Compact, it is one bar while the text fits one
 * line; the first time the text needs a second line (a wrap or a line
 * break, read from the text's laid-out height against one line of it) the
 * text spans the box over a control row, until the draft is empty again.
 * The text grows to the shared cap, then scrolls itself; the attachments
 * and the controls stay outside that region. Rows run from the start edge,
 * so a right-to-left layout mirrors them.
 *
 * The web's `placeholder` is not a slot here: a phone's text field draws its
 * own. Nor is `surface`: the document a web composer floats over is a web
 * surface; `Box` draws a platform's own box.
 */
export const ComposerFrame = ({
  above,
  attachments,
  Box,
  empty,
  leading,
  ring,
  stature,
  text,
  trailing,
  ...viewProps
}: ComposerFrameProps) => {
  const { layout, measured } = useComposerLayout(stature, empty);
  // A line grows with the reader's text size, as the text does.
  const { fontScale } = useWindowDimensions();
  const measureText = (event: LayoutChangeEvent) => {
    measured(
      event.nativeEvent.layout.height,
      COMPOSER_NATIVE_LINE_HEIGHT * fontScale,
    );
  };
  const bar = layout === "bar";

  // The text cell keeps its place among the row's children in both layouts,
  // so the switch never remounts the field: it keeps its focus, its caret
  // and the keyboard. Only the controls move, between the bar's seats and
  // the control row.
  const content = (
    <>
      {above}
      {attachments}
      <View className={COMPOSER_ROW_CLASS[layout]}>
        {bar ? (
          <View className={COMPOSER_BAR_SEAT_CLASS}>{leading}</View>
        ) : null}
        <View className={COMPOSER_TEXT_CELL_CLASS[layout]}>
          <View
            className={cn(
              COMPOSER_TEXT_REGION_MAX_HEIGHT_CLASS,
              stature === "large" && COMPOSER_LARGE_TEXT_CLASS,
            )}
            onLayout={measureText}
          >
            {text}
          </View>
        </View>
        {bar ? (
          <View className={COMPOSER_BAR_SEAT_CLASS}>{trailing}</View>
        ) : null}
        {bar ? null : (
          <View className={COMPOSER_CONTROL_ROW_CLASS}>
            <View className={COMPOSER_CONTROL_GROUP_CLASS}>{leading}</View>
            <View className={COMPOSER_CONTROL_GROUP_CLASS}>{trailing}</View>
          </View>
        )}
      </View>
    </>
  );

  return Box === undefined ? (
    <View
      {...viewProps}
      className={cn(COMPOSER_BOX_CLASS, COMPOSER_RING_CLASS[ring])}
    >
      {content}
    </View>
  ) : (
    <View {...viewProps}>
      <Box>{content}</Box>
    </View>
  );
};
