import { expect } from "bun:test";

const start = Date.now(); // kit-allow: fixture needs ambient elapsed inputs
const end = Date.now(); // kit-allow: fixture needs ambient elapsed inputs

// oxlint-disable-next-line no-wallclock-assertions-in-tests/no-wallclock-assertions-in-tests -- fixture: elapsed threshold must be reported
expect(end - start).toBeLessThan(100);

// expect-clean: no-wallclock-assertions-in-tests/no-wallclock-assertions-in-tests
expect(3).toBeLessThan(100);
