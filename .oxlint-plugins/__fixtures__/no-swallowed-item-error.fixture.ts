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
