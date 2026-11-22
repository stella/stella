import {
  Button,
  HStack,
  Image,
  Link,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  buttonStyle,
  controlSize,
  font,
  foregroundStyle,
  labelStyle,
  lineLimit,
  monospacedDigit,
  padding,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity } from "expo-widgets";
import type {
  LiveActivityEnvironment,
  LiveActivityFactory,
  LiveActivityLayout,
} from "expo-widgets";

import { LIVE_ACTIVITIES } from "@/env";
import { DICTATION_ACTIVITY_NAME } from "@/state/quick-dictation";
import type { DictationActivityProps } from "@/state/quick-dictation";

/**
 * A dictation started outside the app, on the Lock Screen and in the
 * Dynamic Island: while it records, the clock (which the system counts
 * itself), Done, which opens the app on the text, and Cancel, which drops
 * the recording without opening it (`modules/quick-dictation` answers it).
 * Finished, it says the text is ready, and a tap opens the app on it.
 *
 * The native side starts and changes this activity, as a press of the
 * Action Button may come while the app's JavaScript is not running; the
 * layout only has to be registered, which importing this module does.
 */
const DictationActivityLayout = (
  props: DictationActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout => {
  "widget";

  // The function is copied into the widget extension on its own, so it keeps
  // to what it is given and to the imported views and modifiers.
  const primary = { style: "primary", type: "hierarchical" } as const;
  const secondary = { style: "secondary", type: "hierarchical" } as const;
  const recording = props.phase === "recording" && !environment.isStale;
  // Finished, the whole activity opens the app; recording, only Done does.
  const tap = recording ? [] : [widgetURL(props.link)];
  const glyph = (
    <Image
      modifiers={[foregroundStyle(primary)]}
      systemName={recording ? "mic.fill" : "text.bubble"}
    />
  );
  const clock = (size: number) =>
    recording ? (
      <Text
        date={new Date(props.startedAtMs)}
        dateStyle="timer"
        modifiers={[
          font({ size, weight: "semibold" }),
          monospacedDigit(),
          foregroundStyle(primary),
        ]}
      />
    ) : (
      glyph
    );
  const actions = (labelled: boolean) =>
    recording ? (
      <HStack spacing={8}>
        <Button
          label={props.cancelLabel}
          modifiers={[
            buttonStyle("bordered"),
            controlSize("small"),
            labelStyle(labelled ? "titleAndIcon" : "iconOnly"),
          ]}
          systemImage="xmark"
          target={props.cancelTarget}
        />
        <Link
          destination={props.link}
          label={props.finishLabel}
          modifiers={[buttonStyle("borderedProminent"), controlSize("small")]}
        />
      </HStack>
    ) : null;
  const heading = (
    <VStack alignment="leading" spacing={2}>
      <Text
        modifiers={[
          font({ size: 15, weight: "semibold" }),
          lineLimit(1),
          foregroundStyle(primary),
        ]}
      >
        {props.title}
      </Text>
      <Text
        modifiers={[
          font({ size: 13 }),
          lineLimit(1),
          foregroundStyle(secondary),
        ]}
      >
        {props.detail}
      </Text>
    </VStack>
  );

  return {
    banner: (
      <HStack modifiers={[padding({ all: 16 }), ...tap]} spacing={12}>
        {glyph}
        {heading}
        <Spacer />
        <VStack alignment="trailing" spacing={6}>
          {recording ? clock(24) : null}
          {actions(false)}
        </VStack>
      </HStack>
    ),
    compactLeading: glyph,
    compactTrailing: clock(14),
    expandedLeading: <VStack modifiers={tap}>{heading}</VStack>,
    expandedTrailing: recording ? clock(22) : null,
    expandedBottom: (
      <HStack modifiers={tap}>
        <Spacer />
        {actions(true)}
      </HStack>
    ),
    minimal: glyph,
  };
};

/**
 * Registers the layout the native side starts the activity under; null in a
 * build without the widget extension.
 */
export const DictationActivity: LiveActivityFactory<DictationActivityProps> | null =
  LIVE_ACTIVITIES
    ? createLiveActivity<DictationActivityProps>(
        DICTATION_ACTIVITY_NAME,
        DictationActivityLayout,
      )
    : null;
