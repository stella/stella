// Touch every page so the fixture consumes resident memory, not just address space.
const allocations: Uint8Array[] = [];
const timer = setInterval(() => {
  const allocation = new Uint8Array(8 * 1024 * 1024);
  allocation.fill(1);
  allocations.push(allocation);
  // Keep a bounded resident allocation alive for the Windows ancestry query.
  if (allocations.length >= 32) {
    clearInterval(timer);
  }
}, 30);
// Bound the fixture even if the watchdog is removed in a mutation check.
setTimeout(() => process.exit(0), 30_000);
