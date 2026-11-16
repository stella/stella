import { deferred } from "@stll/test-kit";

// oxlint-disable-next-line no-real-timers-in-tests/no-real-timers-in-tests -- fixture: real timer owns the schedule
setTimeout(() => {}, 1);

// expect-clean: no-real-timers-in-tests/no-real-timers-in-tests
deferred();
