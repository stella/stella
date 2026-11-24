import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { MATTER_VISIBILITY } from "@stll/api-contract/matter-visibility";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const { act } = await import("react");
const { cleanup, renderHook } = await import("@testing-library/react");
const { useNewMatterVisibility } = await import("./use-new-matter-visibility");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("the default follows the client field until a level is picked, and a reset follows it again", () => {
  const { result, rerender } = renderHook(
    ({ hasClient }) => useNewMatterVisibility(hasClient),
    { initialProps: { hasClient: false } },
  );
  expect(result.current.visibility).toBe(MATTER_VISIBILITY.assignedOnly);

  rerender({ hasClient: true });
  expect(result.current.visibility).toBe(MATTER_VISIBILITY.adminsAndAssigned);

  act(() => {
    result.current.choose(MATTER_VISIBILITY.allMembers);
  });
  rerender({ hasClient: false });
  expect(result.current.visibility).toBe(MATTER_VISIBILITY.allMembers);
  rerender({ hasClient: true });
  expect(result.current.visibility).toBe(MATTER_VISIBILITY.allMembers);

  act(() => {
    result.current.reset();
  });
  expect(result.current.visibility).toBe(MATTER_VISIBILITY.adminsAndAssigned);
});
