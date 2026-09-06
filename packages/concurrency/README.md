# @stll/concurrency

Bounded-concurrency helpers: run an async operation over a list with a fixed
number in flight.

## What lives here

Two shapes, and the difference is latency.

- `mapWithConcurrency` returns every result, so its caller waits for the
  slowest item.
- `streamWithConcurrency` yields each result in input order as soon as it is
  ready, so a caller that works per result overlaps that work with the
  operations still running. Its `lookAhead` states whether the pool refills on
  completion or on consumption, which is a throughput/residency trade.

Neither is a windowed `Promise.all` over slices. A window refills only once its
slowest member settles, so effective concurrency decays to the tail of every
slice, and whatever the caller does between slices runs with nothing in flight.

## What does not

Job queues and worker processes: bounding in-process fan-out over a list is a
different concern from scheduling durable work.

## License

Apache-2.0
