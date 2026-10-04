import { Temporal, todayFor } from "@stll/time";

import type { SchedulerJob } from "@/api/lib/scheduler/types";

/**
 * The slot a scheduler job was due for: the claimed row's `nextRunAt`.
 *
 * A task decides on this instant, never on the wall clock when the runner got
 * to it. The runner claims a row any time after `nextRunAt`, so a backlog, a
 * deploy or a long task ahead in the sweep can push a Monday 23:00 slot past
 * midnight; a decision taken on the wall clock then sees Tuesday and skips the
 * slot, or sees the next day's slot early and runs it twice.
 *
 * The constructor is private and `of` reads only the claimed row's
 * `nextRunAt` and `lockedAt` (the claim instant the runner wrote), so a
 * `DueSlot` cannot be made from `new Date()` or any other instant.
 */
export class DueSlot {
  readonly #instant: Temporal.Instant;
  readonly #claimedAt: Temporal.Instant;

  private constructor(instant: Temporal.Instant, claimedAt: Temporal.Instant) {
    this.#instant = instant;
    this.#claimedAt =
      Temporal.Instant.compare(claimedAt, instant) < 0 ? instant : claimedAt;
  }

  /** The slot of a claimed scheduler row. */
  static of(
    job: Pick<SchedulerJob, "nextRunAt"> &
      Partial<Pick<SchedulerJob, "lockedAt">>,
  ): DueSlot {
    const instant = Temporal.Instant.fromEpochMilliseconds(
      job.nextRunAt.getTime(),
    );
    return new DueSlot(
      instant,
      job.lockedAt === null || job.lockedAt === undefined
        ? instant
        : Temporal.Instant.fromEpochMilliseconds(job.lockedAt.getTime()),
    );
  }

  get instant(): Temporal.Instant {
    return this.#instant;
  }

  /** The slot as a `Date`, for persistence and APIs that take one. */
  toDate(): Date {
    return new Date(this.#instant.epochMilliseconds);
  }

  /**
   * The instant the runner claimed the row (its `lockedAt`), never before the
   * slot. A sweep that observes current state and checkpoints a cursor judges
   * at this instant: judging it at an older slot would skip what became
   * eligible since, while the cursor still moves past it.
   */
  claimedAtDate(): Date {
    return new Date(this.#claimedAt.epochMilliseconds);
  }

  /** The calendar day of the slot in `zone`. */
  dayIn(zone: string): Temporal.PlainDate {
    return todayFor(zone, this.#instant);
  }

  /**
   * The days in `zone` of every daily slot this claim covers: the due slot and
   * each later slot at the same wall time that had elapsed when the row was
   * claimed, oldest first.
   *
   * The runner collapses a backlog into one run and schedules the next slot
   * after the run finishes, so a day-gated daily task that read only the
   * oldest slot would drop a later slot that had already elapsed (a Sunday
   * 09:00 slot claimed Monday 10:00 is also Monday's 09:00 slot).
   */
  elapsedDailySlotDaysIn(zone: string): Temporal.PlainDate[] {
    const days: Temporal.PlainDate[] = [];
    for (
      let slot = this.#instant.toZonedDateTimeISO(zone);
      Temporal.Instant.compare(slot.toInstant(), this.#claimedAt) <= 0;
      slot = slot.add({ days: 1 })
    ) {
      days.push(slot.toPlainDate());
    }
    return days;
  }
}
