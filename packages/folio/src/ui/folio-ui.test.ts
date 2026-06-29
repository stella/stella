import { describe, expect, test } from "bun:test";

import {
  DEFAULT_COMPONENTS,
  resolveFolioComponents,
  type FolioButtonProps,
} from "./folio-ui";

// A sentinel override component; identity is all the resolution test checks.
const InjectedButton = (_props: FolioButtonProps) => null;

describe("resolveFolioComponents", () => {
  test("returns the defaults when nothing is injected", () => {
    expect(resolveFolioComponents()).toBe(DEFAULT_COMPONENTS);
    expect(resolveFolioComponents(undefined)).toBe(DEFAULT_COMPONENTS);
  });

  test("an empty override still resolves every contract key to a default", () => {
    // A non-undefined override forces a fresh merged object, so identity differs
    // but every value equals its default.
    expect(resolveFolioComponents({})).toEqual(DEFAULT_COMPONENTS);
  });

  test("an injected component wins; unspecified keys fall back to defaults", () => {
    const resolved = resolveFolioComponents({ Button: InjectedButton });
    expect(resolved.Button).toBe(InjectedButton);
    // Every other key is untouched.
    expect(resolved.Dialog).toBe(DEFAULT_COMPONENTS.Dialog);
    expect(resolved.Select).toBe(DEFAULT_COMPONENTS.Select);
    expect(resolved.Menu).toBe(DEFAULT_COMPONENTS.Menu);
    expect(resolved.Input).toBe(DEFAULT_COMPONENTS.Input);
  });

  test("resolution does not mutate the shared defaults object", () => {
    const before = { ...DEFAULT_COMPONENTS };
    resolveFolioComponents({ Button: InjectedButton });
    expect(DEFAULT_COMPONENTS).toEqual(before);
    expect(DEFAULT_COMPONENTS.Button).not.toBe(InjectedButton);
  });

  test("every contract key has a non-null default (no gaps standalone)", () => {
    for (const component of Object.values(DEFAULT_COMPONENTS)) {
      expect(component).toBeDefined();
    }
  });
});
