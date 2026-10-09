export const staleIntersection = new IntersectionObserver((records) =>
  // oxlint-disable-next-line no-first-observer-entry/no-first-observer-entry -- fixture: the first queued record can be stale
  consume(records[0]),
);

export const staleResize = new ResizeObserver((measurements) =>
  // oxlint-disable-next-line no-first-observer-entry/no-first-observer-entry -- fixture: callback parameter spelling does not change record ordering
  consume(measurements.at(0)),
);

export const latestSingleTarget = new IntersectionObserver((records) =>
  // expect-clean: no-first-observer-entry/no-first-observer-entry
  consume(records.at(-1)),
);

export const latestPerTarget = new ResizeObserver((records) => {
  const latest = new Map<Element, ResizeObserverEntry>();
  for (const record of records) {
    latest.set(record.target, record);
  }
  // expect-clean: no-first-observer-entry/no-first-observer-entry
  consume(latest);
});
declare const consume: (value: unknown) => void;
