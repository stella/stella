// Test fixture: a worker that never finishes on its own, for asserting
// that callers can abort a subprocess instead of waiting out its timeout.
await Bun.sleep(600_000);
