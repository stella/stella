// oxlint-disable-next-line no-ambient-time-in-tests/no-ambient-time-in-tests -- fixture: ambient clock must be reported
Date.now();

// expect-clean: no-ambient-time-in-tests/no-ambient-time-in-tests
const epoch = new Date(0);
void epoch;
