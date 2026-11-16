import { expect, test } from "bun:test";

import { buildApp } from "./build-cli-tree.js";
import { insertCapabilities } from "./generate-capability-tree.js";
import { generateResourceTree } from "./generate-resource-tree.js";
import { generateRouteMap } from "./generate-route-map.js";
import { buildInputContractHelp } from "./input-contract-help.js";
import { valueAtPath } from "./output.js";
import { composeInputFromFlags, setPath } from "./run-leaf-command.js";

const keys = ["__proto__", "constructor", "toString", "ordinary"];

test.each(keys)("output paths read only an own %s field", (key) => {
  const inherited = { [key]: { value: "inherited" } };
  const payload = {};
  Object.setPrototypeOf(payload, inherited);
  expect(valueAtPath(payload, `${key}.value`)).toBeUndefined();
  expect(valueAtPath({ [key]: { value: "own" } }, `${key}.value`)).toBe("own");
});

test("required CLI input cannot be satisfied by inherited input or flags", async () => {
  const base: Record<string, unknown> = {};
  const flags = {};
  Object.setPrototypeOf(base, { constructor: "inherited input" });
  Object.setPrototypeOf(flags, { constructor: "inherited flag" });
  const composed = await composeInputFromFlags({
    base,
    flags,
    flagPath: (flag) => flag.prop,
    flagSpecs: [
      {
        flag: "--constructor",
        prop: "constructor",
        kind: "string",
        required: true,
        repeatable: false,
      },
    ],
  });
  expect(composed).toEqual({
    ok: false,
    message: "missing required flag --constructor",
  });
  expect(Object.keys(base)).toEqual([]);
});

test("an unannotated constructor tool still gets its required enum commands", () => {
  const tree = generateRouteMap(
    [
      {
        name: "constructor",
        description: "Fixture operations",
        inputSchema: {
          type: "object",
          properties: { action: { type: "string", enum: ["alpha", "beta"] } },
          required: ["action"],
        },
      },
    ],
    {},
  );
  if (tree.kind !== "route") {
    throw new Error("Expected route root");
  }
  expect(Object.keys(tree.children)).toEqual(["constructor"]);
  const node = Object.values(tree.children).at(0);
  if (node?.kind !== "route") {
    throw new Error("Expected discriminator route");
  }
  expect(Object.keys(node.children)).toEqual(["alpha", "beta"]);
});

test("capability insertion keeps constructor paths and detects their real collision", () => {
  const entries = [
    {
      id: "constructor.get",
      handlerKind: "root",
      access: "read",
      destructive: false,
      scope: "stella:read",
      inputSchema: {},
      transport: { type: "json" },
    },
  ] satisfies Parameters<typeof insertCapabilities>[0]["entries"];
  const tree = generateRouteMap([], {});
  expect(insertCapabilities({ tree, entries }).stats.generated).toBe(1);
  if (tree.kind !== "route") {
    throw new Error("Expected route root");
  }
  const capability = tree.children["capability"];
  if (capability?.kind !== "route") {
    throw new Error("Expected capability route");
  }
  expect(Object.keys(capability.children)).toEqual(["constructor"]);
  expect(() => insertCapabilities({ tree, entries })).toThrow("collides");
});

test.each(keys)(
  "nested CLI input owns %s without traversing its prototype",
  (key) => {
    const inherited = { sentinel: "unchanged" };
    const prototype = { [key]: inherited };
    const target: Record<string, unknown> = {};
    Object.setPrototypeOf(target, prototype);
    setPath(target, `${key}.value`, 42);
    expect(Object.getPrototypeOf(target)).toBe(prototype);
    expect(inherited).toEqual({ sentinel: "unchanged" });
    expect(Object.getOwnPropertyDescriptor(target, key)).toEqual({
      value: { value: 42 },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const child = target[key];
    setPath(target, `${key}.next`, "kept");
    expect(target[key]).toBe(child);
    expect(target[key]).toEqual({ value: 42, next: "kept" });
  },
);

test.each(keys)("CLI input assigns %s as an enumerable leaf", (key) => {
  const target: Record<string, unknown> = { retained: true };
  const prototype = Object.getPrototypeOf(target);
  setPath(target, key, { value: "first" });
  setPath(target, key, { value: "last" });
  expect(Object.getPrototypeOf(target)).toBe(prototype);
  expect(Object.keys(target)).toEqual(["retained", key]);
  expect(JSON.stringify(target)).toBe(
    JSON.stringify({
      retained: true,
      [key]: { value: "last" },
    }),
  );
});

test.each(keys)("CLI help retains the named schema field %s", (key) => {
  const schema = {
    type: "object",
    properties: {
      [key]: {
        type: "object",
        properties: { value: { type: "string", const: "kept" } },
        required: ["value"],
      },
    },
    required: [key],
  };
  const help = buildInputContractHelp({
    schema,
    inputOnly: [key],
    requiredPaths: [`${key}.value`],
  });
  expect(help?.example.status).toBe("complete");
  if (help?.example.status !== "complete") {
    throw new Error("Expected complete schema example");
  }
  expect(Object.getPrototypeOf(help.example.value)).toBe(Object.prototype);
  expect(Object.keys(help.example.value)).toEqual([key]);
  expect(help.example.value[key]).toEqual({ value: "kept" });
  expect(help.fields.join("\n")).toContain(`${key}.value`);
});

test.each(keys)("route generation retains its own %s segment", (key) => {
  const tree = generateRouteMap(
    [
      {
        name: "inspect_record",
        description: "Inspect a fixture record",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    { inspect_record: { command: ["records", key, "get"] } },
  );
  expect(tree.kind).toBe("route");
  if (tree.kind !== "route") {
    throw new Error("Expected route root");
  }
  const records = tree.children["records"];
  if (records?.kind !== "route") {
    throw new Error("Expected records route");
  }
  expect(Object.getPrototypeOf(records.children)).toBe(Object.prototype);
  expect(Object.keys(records.children)).toEqual([key]);
  expect(records.children[key]?.kind).toBe("route");
});

test("resource generation accepts constructor and still rejects a real duplicate", () => {
  const resource = {
    name: "constructor",
    uri: "stella://reference/constructor",
  };
  const tree = generateResourceTree([resource]);
  if (tree.kind !== "route") {
    throw new Error("Expected resource route");
  }
  const show = tree.children["show"];
  if (show?.kind !== "route") {
    throw new Error("Expected show route");
  }
  expect(Object.keys(show.children)).toEqual(["constructor"]);
  expect(show.children.constructor).toMatchObject({
    kind: "leaf",
    spec: { name: "constructor", uri: resource.uri },
  });
  expect(() => generateResourceTree([resource, resource])).toThrow(
    "Duplicate resource command",
  );
});

test("application construction retains a constructor command from generated routes", () => {
  const tree = generateRouteMap(
    [
      {
        name: "inspect_record",
        description: "Inspect a fixture record",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    { inspect_record: { command: ["constructor", "get"] } },
  );
  const root = buildApp(tree).root;
  if (!("getAllEntries" in root)) {
    throw new Error("Expected application route map");
  }
  expect(root.getAllEntries().map((entry) => entry.name.original)).toContain(
    "constructor",
  );
});
