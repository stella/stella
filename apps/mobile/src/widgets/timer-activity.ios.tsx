import { HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  font,
  foregroundStyle,
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
import type { TimerActivityProps } from "@/state/timer-activity";

/**
 * A running timer on the Lock Screen and in the Dynamic Island, as t3code
 * shows a working agent: what is being timed, its matter, and the clock,
 * which the system counts itself while the timer runs, so the app need not
 * wake each second. A paused timer shows its clock still. A tap opens the
 * timers.
 */
const TimerActivityLayout = (
  props: TimerActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout => {
  "widget";

  // The function is copied into the widget extension on its own, so it keeps
  // to what it is given and to the imported views and modifiers.
  const primary = { style: "primary", type: "hierarchical" } as const;
  const secondary = { style: "secondary", type: "hierarchical" } as const;
  const link = [widgetURL(props.link)];
  const clock = (size: number) =>
    props.running && !environment.isStale ? (
      <Text
        date={new Date(props.countingFromMs)}
        dateStyle="timer"
        modifiers={[
          font({ size, weight: "semibold" }),
          monospacedDigit(),
          foregroundStyle(primary),
        ]}
      />
    ) : (
      <Text
        modifiers={[
          font({ size, weight: "semibold" }),
          monospacedDigit(),
          foregroundStyle(secondary),
        ]}
      >
        {props.clock}
      </Text>
    );
  const glyph = (
    <Image
      modifiers={[foregroundStyle(props.running ? primary : secondary)]}
      systemName={props.running ? "timer" : "pause.circle"}
    />
  );

  return {
    banner: (
      <HStack modifiers={[padding({ all: 16 }), ...link]} spacing={12}>
        {glyph}
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
            {props.detail === "" ? props.status : props.detail}
          </Text>
        </VStack>
        <Spacer />
        {clock(24)}
      </HStack>
    ),
    compactLeading: glyph,
    compactTrailing: clock(14),
    expandedBottom: (
      <HStack modifiers={link}>
        <Text modifiers={[font({ size: 13 }), foregroundStyle(secondary)]}>
          {props.status}
        </Text>
        <Spacer />
      </HStack>
    ),
    expandedLeading: (
      <VStack alignment="leading" modifiers={link} spacing={2}>
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
    ),
    expandedTrailing: clock(22),
    minimal: glyph,
  };
};

/**
 * Starts, updates and ends the timer's Live Activity; null in a build
 * without the widget extension.
 */
export const TimerActivity: LiveActivityFactory<TimerActivityProps> | null =
  LIVE_ACTIVITIES
    ? createLiveActivity<TimerActivityProps>(
        "TimerActivity",
        TimerActivityLayout,
      )
    : null;
