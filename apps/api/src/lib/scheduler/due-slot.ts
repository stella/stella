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
 * The constructor is private and `of` reads only `nextRunAt`, so a `DueSlot`
 * cannot be made from `new Date()` or any other instant.
 */
export class DueSlot {
  readonly #instant: Temporal.Instant;

  private constructor(instant: Temporal.Instant) {
    this.#instant = instant;
  }

  /** The slot of a claimed scheduler row. */
  static of(job: Pick<SchedulerJob, "nextRunAt">): DueSlot {
    return new DueSlot(
      Temporal.Instant.fromEpochMilliseconds(job.nextRunAt.getTime()),
    );
  }

  get instant(): Temporal.Instant {
    return this.#instant;
  }

  /** The slot as a `Date`, for persistence and APIs that take one. */
  toDate(): Date {
    return new Date(this.#instant.epochMilliseconds);
  }

  /** The calendar day of the slot in `zone`. */
  dayIn(zone: string): Temporal.PlainDate {
    return todayFor(zone, this.#instant);
  }
}
