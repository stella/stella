declare const items: unknown[];
for (const item of items) {
  try {
    String(item);
  }
  // expect-clean: no-swallowed-item-error/no-swallowed-item-error
  catch {
    continue;
  }
  try {
    String(item);
  }
  // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: an existing budget cannot grow
  catch {
    // Fixture deliberately leaves the item failure unrecorded.
  }
}
