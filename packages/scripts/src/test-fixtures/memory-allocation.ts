// Touch every page so the fixture consumes resident memory, not just address space.
const allocations: Uint8Array[] = [];
setInterval(() => {
  const allocation = new Uint8Array(8 * 1024 * 1024);
  allocation.fill(1);
  allocations.push(allocation);
  // Bound the fixture even if the watchdog is removed in a mutation check.
  if (allocations.length >= 32) {
    process.exit(0);
  }
}, 30);
