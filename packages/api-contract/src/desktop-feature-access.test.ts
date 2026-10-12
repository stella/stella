import { expect, test } from "bun:test";

import {
  DESKTOP_FEATURE_ACCESS_PATH,
  DESKTOP_FEATURE_IDS,
} from "./desktop-feature-access";
import contract from "./desktop-feature-access.json";

test("the native contract file matches the typed desktop feature access contract", () => {
  expect(contract).toStrictEqual({
    path: DESKTOP_FEATURE_ACCESS_PATH,
    featureIds: [...DESKTOP_FEATURE_IDS],
  });
});
