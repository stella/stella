# @stll/test-kit

Hermetic, deterministic test primitives. A test built from these does not
depend on how fast the machine is, what time it is, which files a previous
run left behind, or whether the internet is reachable.

| Need                                            | Use                                                                                 | Instead of                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Time that moves only when the test says so      | `createTestClock()`; pass it where the code takes a `Clock`                         | `Date.now()`, `performance.now()`, `Bun.sleep`, `setTimeout` |
| Wait for something that happens                 | `deferred()`, `waitForEvent()`, `waitForAbort()`                                    | sleeping and hoping                                          |
| Wait for state without an event (a row, a file) | `waitFor(probe, { description })`                                                   | a hand-written poll loop                                     |
| A deadline that only catches hangs              | `settledWithin(promise, { description })`                                           | `Promise.race` with a short timer as an assertion            |
| A private directory per test                    | `useTestTmpDir()`, `withTestTmpDir()`, `await using dir = await createTestTmpDir()` | `mkdtemp(tmpdir())` and manual cleanup                       |
| No outbound network                             | preload `@stll/test-kit/forbid-network`, or `installNetworkGuard()`                 | relying on the CI network                                    |
| Database timestamps compared with `now()`       | `dbClock.ago(ms)` / `dbClock.fromNow(ms)` from `@stll/test-kit/db`                  | `new Date(Date.now() - ms)` written into a column            |

## Request scopes

`runInRequest(scenario, request?)` from `@stll/test-kit/request` runs a scenario
inside a TanStack Start request context. It rethrows the original scenario
failure after the framework handler completes and asserts a successful HTTP
status, so assertions cannot disappear into generated error responses.

## Clock

`createTestClock()` starts at a fixed instant. `advance(ms)` wakes every due
sleeper in deadline order and lets the work it schedules run before the next
one wakes, so a periodic loop driven by the clock runs the same way on every
machine. `setTime()` changes only the wall clock, like a system clock change.

## Waits

Every wait takes a `description`. The hang guard (20 s by default, below the
30 s per-test cap) fails with "waiting for <description>", so a stuck test
says what it was waiting for. The guard is never a statement about speed: do
not shorten it to assert that something is fast. Assert work counts instead.

## Database clock

Postgres compares rows with its own `now()`. A JavaScript timestamp written
into a column that the code compares with `now()` mixes two clocks.
`dbClock` builds those values from the database clock instead.
