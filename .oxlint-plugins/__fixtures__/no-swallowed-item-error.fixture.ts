declare const items: string[];
declare const build: (item: string) => Promise<void>;
declare const record: (failure: {
  type: "item_build_failed";
  cause: unknown;
}) => void;

async function buildItems() {
  for (const item of items) {
    try {
      await build(item);
    }
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: skipping an item must surface its failure
    catch {
      continue;
    }
    try {
      await build(item);
    }
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: an empty handler discards the failure
    catch {
      // Fixture deliberately leaves the item failure unrecorded.
    }
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: a promise fallback discards the failure
    await build(item).catch(() => undefined);
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: null hides an item failure
    await build(item).catch(() => null);
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: an empty array hides an item failure
    await build(item).catch(() => []);
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: false hides an item failure
    await build(item).catch(() => false);
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: true hides an item failure
    await build(item).catch(() => true);
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: zero hides an item failure
    await build(item).catch(() => 0);
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: a number hides an item failure
    await build(item).catch(() => 42);
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: a negative number hides an item failure
    await build(item).catch(() => -1);
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: an empty string hides an item failure
    await build(item).catch(() => "");
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: a string hides an item failure
    await build(item).catch(() => "fallback");
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: an empty object hides an item failure
    await build(item).catch(() => ({}));
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error, no-void -- fixture: void zero hides an item failure
    await build(item).catch(() => void 0);
    try {
      await build(item);
    }
    // oxlint-disable-next-line no-swallowed-item-error/no-swallowed-item-error -- fixture: a constant catch return hides an item failure
    catch {
      return false;
    }
    try {
      await build(item);
    }
    // expect-clean: no-swallowed-item-error/no-swallowed-item-error
    catch (error) {
      record({ type: "item_build_failed", cause: error });
      continue;
    }
    try {
      await build(item);
    }
    // expect-clean: no-swallowed-item-error/no-swallowed-item-error
    catch (error) {
      record({ type: "item_build_failed", cause: error });
      throw error;
    }
  }
  // expect-clean: no-swallowed-item-error/no-swallowed-item-error
  const parseOptional = () => {
    try {
      return JSON.parse("invalid");
    } catch {
      return undefined;
    }
  };
  return parseOptional;
}
export { buildItems };
