"use client";

import * as React from "react";

import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion";
import { cn } from "../lib/utils";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "./preview-card";

/**
 * The one animation system for previews that explain a feature by playing it:
 * a frame of ordered stages that cross-fade into each other, an optional
 * carry gesture around a frame, and a hover card that hosts a preview beside
 * the control it explains.
 *
 * The styles live in `animated-preview.css`, shipped through
 * `@stll/ui/theme.css`. A stage's clock is CSS only: stage `i` comes in at
 * `i` holds after its frame starts and goes out one hold later, so a frame
 * nested inside a stage starts when that stage does. With reduced motion a
 * frame renders only its final stage, statically.
 */

/**
 * `once` plays the stages through and rests on the last one. `loop` lets the
 * last stage go out and starts again from the first.
 */
export type AnimatedPreviewPlayback = "once" | "loop";

/**
 * How long each stage holds before the next one crosses over: `glance` for a
 * gesture read at a glance, `read` for a stage carrying a sentence, `beat` for
 * a step inside a stage.
 */
export type AnimatedPreviewPace = "glance" | "read" | "beat";

export type AnimatedPreviewStage = {
  id: string;
  content: React.ReactNode;
};

type AnimatedPreviewProps = {
  stages: readonly [AnimatedPreviewStage, ...AnimatedPreviewStage[]];
  playback?: AnimatedPreviewPlayback;
  pace?: AnimatedPreviewPace;
  /**
   * Steps this frame waits after the stage holding it comes in, so frames
   * nested in one stage can follow each other.
   */
  stagger?: number;
  /** Lays the frame out inline, to sit inside a sentence. */
  inline?: boolean;
  className?: string;
};

type AnimatedPreviewFrameStyle = React.CSSProperties & {
  "--animated-preview-stagger": number;
};

type AnimatedPreviewStageStyle = React.CSSProperties & {
  "--animated-preview-stage-index": number;
};

/** Must match the keyframes name in `animated-preview.css`. */
const STAGE_OUT_KEYFRAMES = "animated-preview-fade-out";

export const AnimatedPreview = ({
  stages,
  playback = "once",
  pace = "glance",
  stagger = 0,
  inline = false,
  className,
}: AnimatedPreviewProps) => {
  const reducedMotion = usePrefersReducedMotion();
  // Bumped when a looping frame's last stage has gone out: the new keys
  // remount every stage, which restarts their CSS clocks from zero.
  const [cycle, setCycle] = React.useState(0);
  const Frame = inline ? "span" : "div";
  const lastIndex = stages.length - 1;
  const finalStage = stages[lastIndex] ?? stages[0];
  const frameStyle: AnimatedPreviewFrameStyle = {
    "--animated-preview-stagger": stagger,
  };

  const restartLoop = (event: React.AnimationEvent<HTMLElement>) => {
    const stage = event.target;
    if (
      playback === "loop" &&
      event.animationName === STAGE_OUT_KEYFRAMES &&
      stage instanceof HTMLElement &&
      stage.parentElement === event.currentTarget &&
      stage.dataset["stageIndex"] === String(lastIndex)
    ) {
      setCycle((current) => current + 1);
    }
  };

  return (
    <Frame
      className={className}
      data-motion={reducedMotion ? "reduced" : "full"}
      data-pace={pace}
      data-playback={playback}
      data-slot="animated-preview"
      onAnimationEnd={reducedMotion ? undefined : restartLoop}
      style={frameStyle}
    >
      {reducedMotion ? (
        <StageFrame
          incoming={false}
          index={lastIndex}
          inline={inline}
          outgoing={false}
        >
          {finalStage.content}
        </StageFrame>
      ) : (
        stages.map((stage, index) => (
          <StageFrame
            // The first stage of a one-off sequence is there from the start;
            // every other stage comes in on its turn.
            incoming={index > 0 || playback === "loop"}
            index={index}
            inline={inline}
            key={`${cycle}:${stage.id}`}
            // The last stage of a one-off sequence stays.
            outgoing={index < lastIndex || playback === "loop"}
          >
            {stage.content}
          </StageFrame>
        ))
      )}
    </Frame>
  );
};

type StageFrameProps = React.PropsWithChildren<{
  index: number;
  incoming: boolean;
  outgoing: boolean;
  inline: boolean;
}>;

const StageFrame = ({
  index,
  incoming,
  outgoing,
  inline,
  children,
}: StageFrameProps) => {
  const Stage = inline ? "span" : "div";
  const stageStyle: AnimatedPreviewStageStyle = {
    "--animated-preview-stage-index": index,
  };

  return (
    <Stage
      data-incoming={incoming ? "" : undefined}
      data-outgoing={outgoing ? "" : undefined}
      data-slot="animated-preview-stage"
      data-stage-index={index}
      style={stageStyle}
    >
      {children}
    </Stage>
  );
};

type AnimatedPreviewMotionProps = React.ComponentProps<"div"> & {
  pace?: AnimatedPreviewPace;
};

/**
 * Carries its content along: picked up (lift, tilt, shadow), moved, and put
 * down as the frame inside it crosses from its first stage to its second.
 * The caller places the drop with `--animated-preview-carry-x` and
 * `--animated-preview-carry-y`; with reduced motion the content rests there.
 */
export const AnimatedPreviewMotion = ({
  className,
  pace = "glance",
  ...props
}: AnimatedPreviewMotionProps) => {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div
      className={className}
      data-motion={reducedMotion ? "reduced" : "full"}
      data-pace={pace}
      data-slot="animated-preview-motion"
      {...props}
    />
  );
};

/** How long a pointer or keyboard focus rests on the trigger before the card opens. */
export const ANIMATED_PREVIEW_CARD_DELAY_MS = 400;

type AnimatedPreviewCardProps = React.PropsWithChildren<{
  /**
   * The control the card explains. It must take the props it is handed, as a
   * `Button` does: the card opens from its hover and focus events.
   */
  trigger: React.ReactElement;
  /**
   * One line on what the control does. Shown under the preview and read as
   * the control's description, so the moving preview itself stays out of the
   * accessibility tree.
   */
  description: React.ReactNode;
  className?: string;
}>;

/**
 * A preview card opened by hovering or focusing a control. It takes no focus
 * and traps none: the card describes the control, and the control stays the
 * thing that is used.
 */
export const AnimatedPreviewCard = ({
  trigger,
  description,
  className,
  children,
}: AnimatedPreviewCardProps) => {
  const descriptionId = React.useId();

  return (
    <PreviewCard>
      <PreviewCardTrigger
        aria-describedby={descriptionId}
        delay={ANIMATED_PREVIEW_CARD_DELAY_MS}
        render={trigger}
      />
      {/* Outside the popup, which is mounted only while open: the
          description has to exist for the trigger at all times. */}
      <span className="sr-only" id={descriptionId}>
        {description}
      </span>
      <PreviewCardPopup
        className={cn("w-72 flex-col gap-2 p-3", className)}
        data-slot="animated-preview-card"
      >
        <div aria-hidden className="flex flex-col gap-2">
          {children}
          <p
            className="text-muted-foreground text-xs"
            data-slot="animated-preview-card-description"
          >
            {description}
          </p>
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
};
