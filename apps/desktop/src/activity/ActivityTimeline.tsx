import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

import { useFormatter, useTranslations } from "use-intl";

import type {
  DesktopMatter,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { resolveMatterColor } from "@stll/ui/matter-colors";
import { MatterIcon } from "@stll/ui/matter-icon";
import {
  Tooltip,
  TooltipCreateHandle,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "@stll/ui/tooltip";

import type { ActivityDaySnapshot } from "./activity-types";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import type { MatchedSegment } from "./day-review-logic";
import { MatterPicker } from "./MatterPicker";

const DRAG_THRESHOLD_PX = 4;

type Range = { startMs: number; endMs: number };
type DragOrigin = { instant: number; clientX: number; pointerId: number };
export type TimelineSegment = MatchedSegment & { type: "active" | "idle" };

export const ActivityTimeline = ({
  segments,
  snapshot,
  candidates,
  disabled,
  onAssign,
  mode = "review",
}: {
  segments: readonly TimelineSegment[];
  snapshot: ActivityDaySnapshot;
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  disabled: boolean;
  onAssign: (range: Range, matter: DesktopMatter) => void;
  mode?: "review" | "preview";
}) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const [selection, setSelection] = useState<Range | null>(null);
  const [tooltipHandle] = useState(() =>
    TooltipCreateHandle<TimelineSegment>(),
  );
  const origin = useRef<DragOrigin | null>(null);
  const dragged = useRef(false);
  const [now, setNow] = useState(
    () => Temporal.Now.instant().epochMilliseconds,
  );
  useEffect(() => {
    if (
      snapshot.recordingStatus !== "recording" ||
      snapshot.date !== snapshot.today
    ) {
      return undefined;
    }
    const timer = setInterval(
      () => setNow(Temporal.Now.instant().epochMilliseconds),
      30_000,
    );
    return () => clearInterval(timer);
  }, [snapshot.recordingStatus, snapshot.date, snapshot.today]);
  const first = segments.at(0);
  const last = segments.at(-1);
  if (!first || !last) {
    return null;
  }
  const zone = Temporal.Now.timeZoneId();
  const start = Temporal.Instant.fromEpochMilliseconds(first.startMs)
    .toZonedDateTimeISO(zone)
    .round({ smallestUnit: "hour", roundingMode: "floor" }).epochMilliseconds;
  const recordedEnd =
    snapshot.recordingStatus === "recording" && snapshot.date === snapshot.today
      ? Math.max(last.endMs, now)
      : last.endMs;
  const end = Temporal.Instant.fromEpochMilliseconds(recordedEnd)
    .toZonedDateTimeISO(zone)
    .round({ smallestUnit: "hour", roundingMode: "ceil" }).epochMilliseconds;
  const span = end - start || 3_600_000;
  const pct = (instant: number) => ((instant - start) / span) * 100;
  const ticks = Array.from(
    { length: Math.floor(span / 3_600_000) + 1 },
    (_, index) => start + index * 3_600_000,
  );
  const time = (value: number) =>
    format.dateTime(new Date(value), { hour: "2-digit", minute: "2-digit" });
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.round(
      start +
        Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) *
          span,
    );
  };
  const pointerHandlers = () =>
    createTimelinePointerHandlers({
      disabled,
      origin,
      dragged,
      point,
      setSelection,
    });
  const selected =
    selection && selection.endMs > selection.startMs ? selection : null;
  const legend = [
    ...new Map(
      segments.flatMap(({ matter }) =>
        matter ? [[matter.id, matter] as const] : [],
      ),
    ).values(),
  ];
  return (
    <section
      className="flex flex-col gap-2"
      aria-label={
        snapshot.date === snapshot.today ? t("reviewToday") : t("reviewDay")
      }
    >
      <div className="relative select-none" dir="ltr">
        <div className="text-muted-foreground text-2xs relative h-5 tabular-nums">
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className="absolute whitespace-nowrap"
              style={{
                left: `${pct(tick)}%`,
                transform: tickTransform(index, ticks.length),
              }}
            >
              {time(tick)}
            </span>
          ))}
        </div>
        <TooltipProvider>
          <div
            className={`bg-muted relative mt-1 h-9 touch-none overflow-clip rounded-lg ${mode === "review" ? "cursor-crosshair" : ""}`}
            onPointerDown={(event) => pointerHandlers().onPointerDown(event)}
            onPointerMove={(event) => pointerHandlers().onPointerMove(event)}
            onPointerUp={(event) => pointerHandlers().onPointerUp(event)}
            onPointerCancel={() => pointerHandlers().onPointerCancel()}
          >
            {segments.map((segment, index) => (
              <TooltipTrigger
                key={`${segment.startMs}-${segment.appIdentifier}`}
                handle={tooltipHandle}
                payload={segment}
                render={<button type="button" />}
                data-activity-segment=""
                data-activity-away={segment.type === "idle" ? "" : undefined}
                className={`absolute inset-y-1 flex min-w-0 items-center gap-1 overflow-clip rounded-md border px-1 ${segment.type === "idle" ? "" : "bg-card"} ${segment.drafted ? "opacity-50" : ""}`}
                style={{
                  left: `${pct(segment.startMs)}%`,
                  width: `${pct(segment.endMs) - pct(segment.startMs)}%`,
                  animationDelay: `${Math.min(index, 8) * 70}ms`,
                }}
                aria-label={`${time(segment.startMs)} – ${time(segment.endMs)} · ${segment.appName}`}
                onClick={(event) => {
                  if (
                    !disabled &&
                    !segment.drafted &&
                    (!dragged.current || event.detail === 0)
                  ) {
                    setSelection({
                      startMs: segment.startMs,
                      endMs: segment.endMs,
                    });
                  }
                  dragged.current = false;
                }}
              >
                {segment.type === "idle" ? null : (
                  <ActivitySourceIcon
                    appIdentifier={segment.appIdentifier}
                    sourceAppVisuals={snapshot.sourceAppVisuals}
                  />
                )}
              </TooltipTrigger>
            ))}
            {selected ? (
              <div
                className="bg-info/15 border-info pointer-events-none absolute inset-y-0 border-x-2"
                style={{
                  left: `${pct(selected.startMs)}%`,
                  width: `${pct(selected.endMs) - pct(selected.startMs)}%`,
                }}
              />
            ) : null}
          </div>
          <Tooltip handle={tooltipHandle}>
            {({ payload }) =>
              payload ? (
                <SegmentTooltip segment={payload} snapshot={snapshot} />
              ) : null
            }
          </Tooltip>
        </TooltipProvider>
        <div
          data-activity-matter-lane=""
          className="relative mt-1 h-2.5 overflow-clip rounded"
        >
          {segments.map((segment, index) =>
            segment.matter ? (
              <div
                key={`${segment.startMs}-${segment.appIdentifier}`}
                data-activity-segment=""
                className={`absolute inset-y-0 rounded-sm ${segment.drafted ? "opacity-40" : "opacity-85"}`}
                style={{
                  left: `${pct(segment.startMs)}%`,
                  width: `${pct(segment.endMs) - pct(segment.startMs)}%`,
                  backgroundColor: resolveMatterColor(
                    segment.matter.id,
                    segment.matter.color,
                  ),
                  animationDelay: `${Math.min(index, 8) * 70}ms`,
                }}
              />
            ) : null,
          )}
        </div>
        {snapshot.recordingStatus === "recording" &&
        snapshot.date === snapshot.today &&
        now >= start &&
        now <= end ? (
          <div
            className="bg-destructive pointer-events-none absolute top-5 bottom-0 w-0.5 rounded"
            style={{ left: `${pct(now)}%` }}
          >
            <span className="bg-destructive absolute -start-0.5 -top-1 size-1.5 rounded-full" />
          </div>
        ) : null}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {legend.map((matter) => (
          <span className="flex items-center gap-1.5" key={matter.id}>
            <MatterIcon matter={matter} className="size-3" />
            <bdi>{matter.name}</bdi>
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <i data-activity-away="" className="size-3 rounded-sm" />
          {t("awayNotCounted")}
        </span>
      </div>
      {mode === "review" ? (
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
          <p>{t("timelineHint")}</p>
          <Button
            disabled={disabled}
            variant="ghost"
            size="sm"
            onClick={() =>
              setSelection({ startMs: first.startMs, endMs: last.endMs })
            }
          >
            {t("selectRange")}
          </Button>
        </div>
      ) : null}
      {selection ? (
        <div className="bg-muted flex flex-wrap items-end gap-3 rounded-lg p-3">
          <RangeTimeField
            invalid={!selected}
            label={t("rangeStart")}
            instant={selection.startMs}
            date={snapshot.date}
            disabled={disabled}
            onChange={(startMs) =>
              setSelection({ startMs, endMs: selection.endMs })
            }
          />
          <RangeTimeField
            invalid={!selected}
            label={t("rangeEnd")}
            instant={selection.endMs}
            date={snapshot.date}
            disabled={disabled}
            onChange={(endMs) =>
              setSelection({ startMs: selection.startMs, endMs })
            }
          />
          <MatterPicker
            disabled={disabled || !selected}
            candidates={candidates}
            label={t("assignRange")}
            onChoose={(matter) => {
              if (!selected) {
                return;
              }
              onAssign(selected, matter);
              setSelection(null);
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
            {t("cancel")}
          </Button>
        </div>
      ) : null}
    </section>
  );
};

type TimelinePointerHandlersOptions = {
  disabled: boolean;
  origin: { current: DragOrigin | null };
  dragged: { current: boolean };
  point: (event: PointerEvent<HTMLDivElement>) => number;
  setSelection: (range: Range | null) => void;
};

const createTimelinePointerHandlers = ({
  disabled,
  origin,
  dragged,
  point,
  setSelection,
}: TimelinePointerHandlersOptions) => ({
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) {
      return;
    }
    dragged.current = false;
    const instant = point(event);
    origin.current = {
      instant,
      clientX: event.clientX,
      pointerId: event.pointerId,
    };
    setSelection({ startMs: instant, endMs: instant });
  },
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
    const initial = origin.current;
    if (!initial || initial.pointerId !== event.pointerId) {
      return;
    }
    if (event.buttons === 0) {
      origin.current = null;
      setSelection(null);
      return;
    }
    if (!dragged.current) {
      if (Math.abs(event.clientX - initial.clientX) < DRAG_THRESHOLD_PX) {
        return;
      }
      dragged.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const current = point(event);
    setSelection({
      startMs: Math.min(initial.instant, current),
      endMs: Math.max(initial.instant, current),
    });
  },
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
    const initial = origin.current;
    if (!initial || initial.pointerId !== event.pointerId) {
      return;
    }
    const current = point(event);
    const range = {
      startMs: Math.min(initial.instant, current),
      endMs: Math.max(initial.instant, current),
    };
    setSelection(dragged.current ? range : null);
    origin.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  },
  onPointerCancel: () => {
    origin.current = null;
    dragged.current = false;
    setSelection(null);
  },
});

const tickTransform = (index: number, length: number) => {
  if (index === 0) {
    return undefined;
  }
  if (index === length - 1) {
    return "translateX(-100%)";
  }
  return "translateX(-50%)";
};

const SegmentTooltip = ({
  segment,
  snapshot,
}: {
  segment: TimelineSegment;
  snapshot: ActivityDaySnapshot;
}) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const time = (instant: number) =>
    format.dateTime(new Date(instant), { hour: "2-digit", minute: "2-digit" });
  return (
    <TooltipPopup side="bottom" className="max-w-72 p-2">
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground tabular-nums">
          {time(segment.startMs)} – {time(segment.endMs)} ·{" "}
          {t("durationMinutes", {
            minutes: Math.ceil((segment.endMs - segment.startMs) / 60_000),
          })}
        </span>
        <bdi>
          {segment.type === "idle" ? t("awayNotCounted") : segment.appName}
        </bdi>
        {snapshot.captureDetails &&
        (segment.document || segment.windowTitle) ? (
          <bdi className="text-muted-foreground wrap-break-word">
            {segment.document?.split(/[\\/]/u).at(-1) || segment.windowTitle}
          </bdi>
        ) : null}
        {segment.matter ? (
          <span className="flex gap-1">
            <MatterIcon matter={segment.matter} className="size-3" />
            <bdi>{segment.matter.name}</bdi>
          </span>
        ) : null}
        {segment.drafted ? t("draftedEntry") : null}
      </div>
    </TooltipPopup>
  );
};

const RangeTimeField = ({
  label,
  instant,
  date,
  disabled,
  invalid,
  onChange,
}: {
  label: string;
  instant: number;
  date: string;
  disabled: boolean;
  invalid: boolean;
  onChange: (instant: number) => void;
}) => {
  const t = useTranslations("activity");
  const zone = Temporal.Now.timeZoneId();
  const local =
    Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(zone);
  const hour = local.toPlainDate().toString() === date ? local.hour : 24;
  const update = (hours: number, minutes: number) => {
    const time = Temporal.PlainDate.from(date).toPlainDateTime({
      hour: Math.min(hours, 23),
      minute: minutes,
    });
    const changed =
      hours === 24 ? time.add({ days: 1 }).with({ hour: 0, minute: 0 }) : time;
    onChange(changed.toZonedDateTime(zone).epochMilliseconds);
  };
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm">{label}</legend>
      <div className="flex gap-1">
        <Label className="flex-col items-start gap-1">
          {t("hours", { hours: "" })}
          <Input
            aria-invalid={invalid}
            type="number"
            className="w-16"
            min={0}
            max={24}
            step={1}
            value={hour}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.valueAsNumber;
              if (Number.isInteger(value) && value >= 0 && value <= 24) {
                update(value, local.minute);
              }
            }}
          />
        </Label>
        <Label className="flex-col items-start gap-1">
          {t("durationMinutes", { minutes: "" })}
          <Input
            aria-invalid={invalid}
            type="number"
            className="w-16"
            min={0}
            max={59}
            step={1}
            value={hour === 24 ? 0 : local.minute}
            disabled={disabled || hour === 24}
            onChange={(event) => {
              const value = event.target.valueAsNumber;
              if (Number.isInteger(value) && value >= 0 && value <= 59) {
                update(hour, value);
              }
            }}
          />
        </Label>
      </div>
    </fieldset>
  );
};
