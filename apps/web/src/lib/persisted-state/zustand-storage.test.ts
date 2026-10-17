import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, expect, test } from "bun:test";
import * as v from "valibot";

import { deviceStorage } from "@/lib/account/browser-storage";
import {
  definePersistedState,
  keepInAnyScope,
} from "@/lib/persisted-state/registry";
import { registryZustandStorage } from "@/lib/persisted-state/zustand-storage";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const values = deviceStorage("local");

const entry = definePersistedState({
  key: "stella:inspector-pane-width:zustand-test",
  area: "local",
  version: 1,
  schema: v.nullable(
    v.object({ state: v.object({ count: v.number() }), version: v.number() }),
  ),
  maxBytes: 1024,
  defaultValue: () => null,
  scopeCheck: keepInAnyScope,
  restoredUi: false,
});
const storage = registryZustandStorage(entry, {});

beforeEach(() => values.removeItem("stella:inspector-pane-width:zustand-test"));

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("round trips Zustand state through the registry", () => {
  storage.setItem("ignored", { state: { count: 2 }, version: 3 });
  expect(storage.getItem("ignored")).toEqual({
    state: { count: 2 },
    version: 3,
  });
});

test("malformed stored state falls back to the default", () => {
  values.setItem("stella:inspector-pane-width:zustand-test", "{broken");
  expect(storage.getItem("ignored")).toBeNull();
  expect(values.getItem("stella:inspector-pane-width:zustand-test")).toBeNull();
});
