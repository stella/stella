import { expect } from "bun:test";

// oxlint-disable-next-line no-ambient-time-in-tests/no-ambient-time-in-tests -- fixture: elapsed assertion needs an ambient start
const start = Date.now();
// oxlint-disable-next-line no-ambient-time-in-tests/no-ambient-time-in-tests -- fixture: elapsed assertion needs an ambient end
const end = Date.now();

// oxlint-disable-next-line no-wallclock-assertions-in-tests/no-wallclock-assertions-in-tests -- fixture: elapsed threshold must be reported
expect(end - start).toBeLessThan(100);

// expect-clean: no-wallclock-assertions-in-tests/no-wallclock-assertions-in-tests
expect(3).toBeLessThan(100);
