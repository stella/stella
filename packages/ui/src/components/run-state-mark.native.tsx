import { useEffect, useState } from "react";

import { panic } from "better-result";
import { Animated, Easing, Text } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useCSSVariable } from "uniwind";

import {
  RUN_MARK_SIZES,
  RUN_MARK_TONES,
  RUN_STATE_MARKS,
  type RunStateMarkContract,
} from "./run-state-mark.shared";
import {
  STATUS_MARK_RING_RADIUS,
  STATUS_MARK_RUNNING_ARC,
  STATUS_MARK_SPIN_MS,
  STATUS_MARK_STROKE_WIDTH,
  STATUS_MARK_TRACK_OPACITY,
  STATUS_MARK_VIEWBOX,
} from "./status-mark.shared";
import { sansFontFamily } from "./text.native";

/**
 * The web's `RunStateMark` (./run-state-mark.tsx) on a phone: the bold "!"
 * in the embedded bold face, or the web `StatusMark`'s running ring drawn
 * with react-native-svg. Hidden from assistive technology, as on the web:
 * the row or heading around it names the state.
 */
export const RunStateMark = ({ size = "row", state }: RunStateMarkContract) => {
  const { glyph, tone } = RUN_STATE_MARKS[state];
  const { glyphClass, px } = RUN_MARK_SIZES[size];
  const { textClass, variable } = RUN_MARK_TONES[tone];
  switch (glyph) {
    case "attention":
      return (
        <Text
          accessibilityElementsHidden
          className={`${textClass} ${glyphClass} leading-none`}
          importantForAccessibility="no-hide-descendants"
          style={{ fontFamily: sansFontFamily("bold") }}
        >
          !
        </Text>
      );
    case "running":
      return <RunningRing colorVariable={variable} px={px} />;
    default:
      glyph satisfies never;
      return panic("Unhandled run mark glyph");
  }
};

const CENTRE = 8;
const CIRCUMFERENCE = 2 * Math.PI * STATUS_MARK_RING_RADIUS;
const ARC_DASHES = [
  CIRCUMFERENCE * STATUS_MARK_RUNNING_ARC,
  CIRCUMFERENCE * (1 - STATUS_MARK_RUNNING_ARC),
];

/**
 * The arc turns on its faint track. It keeps turning under Reduce Motion, as
 * the platform's own activity indicator does; the ring is too small to move
 * anything else on screen.
 */
const RunningRing = ({
  colorVariable,
  px,
}: {
  colorVariable: string;
  px: number;
}) => {
  const resolved = useCSSVariable(colorVariable);
  const color = typeof resolved === "string" ? resolved : "currentColor";
  const [turn] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const spin = Animated.loop(
      Animated.timing(turn, {
        duration: STATUS_MARK_SPIN_MS,
        easing: (progress) => Easing.linear(progress),
        isInteraction: false,
        toValue: 1,
        useNativeDriver: true,
      }),
    );
    spin.start();
    return () => {
      spin.stop();
    };
  }, [turn]);
  const rotate = turn.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: px, transform: [{ rotate }], width: px }}
    >
      <Svg fill="none" height={px} viewBox={STATUS_MARK_VIEWBOX} width={px}>
        <Circle
          cx={CENTRE}
          cy={CENTRE}
          opacity={STATUS_MARK_TRACK_OPACITY}
          r={STATUS_MARK_RING_RADIUS}
          stroke={color}
          strokeWidth={STATUS_MARK_STROKE_WIDTH}
        />
        <Circle
          cx={CENTRE}
          cy={CENTRE}
          r={STATUS_MARK_RING_RADIUS}
          stroke={color}
          strokeDasharray={ARC_DASHES}
          strokeLinecap="round"
          strokeWidth={STATUS_MARK_STROKE_WIDTH}
          transform={`rotate(-90 ${CENTRE} ${CENTRE})`}
        />
      </Svg>
    </Animated.View>
  );
};

export type { RunMarkSize, RunMarkState } from "./run-state-mark.shared";
