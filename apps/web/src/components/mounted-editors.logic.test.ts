import { describe, expect, test } from "bun:test";

import {
  mountedEditorFor,
  mountEditor,
} from "@/components/mounted-editors.logic";
import type { MountedEditors } from "@/components/mounted-editors.logic";

describe("mounted editors", () => {
  test("an insert reaches its own thread's composer, not the last mounted", () => {
    const editors: MountedEditors<string> = new Map();
    mountEditor(editors, "main", "main-composer");
    mountEditor(editors, "side", "side-composer");

    expect(mountedEditorFor(editors, "main")).toBe("main-composer");
    expect(mountedEditorFor(editors, "side")).toBe("side-composer");
  });

  test("closing one composer leaves the others reachable", () => {
    const editors: MountedEditors<string> = new Map();
    mountEditor(editors, "main", "main-composer");
    const unmountSide = mountEditor(editors, "side", "side-composer");

    unmountSide();

    expect(mountedEditorFor(editors, "main")).toBe("main-composer");
    expect(mountedEditorFor(editors, "side")).toBeNull();
  });

  test("a thread shown twice targets the newer composer until it closes", () => {
    const editors: MountedEditors<string> = new Map();
    mountEditor(editors, "main", "first");
    const unmountSecond = mountEditor(editors, "main", "second");

    expect(mountedEditorFor(editors, "main")).toBe("second");
    unmountSecond();
    expect(mountedEditorFor(editors, "main")).toBe("first");
  });

  test("nothing mounted yet", () => {
    expect(mountedEditorFor(null, "main")).toBeNull();
  });
});
