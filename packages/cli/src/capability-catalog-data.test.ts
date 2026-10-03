import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  checkCapabilityRegistry,
  readCapabilityCatalog,
} from "./capability-catalog-data.js";

const withShards = (
  shards: Record<string, string>,
  run: (directory: URL) => void,
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-capabilities-"));
  try {
    for (const [filename, content] of Object.entries(shards)) {
      writeFileSync(path.join(directory, filename), content);
    }
    run(pathToFileURL(`${directory}/`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("committed capability shards", () => {
  test("sorts by capability id and preserves the complete raw contract", () => {
    const later = {
      id: "widgets.zebra",
      feature: "feature",
      consumesServices: true,
      mcp: { type: "advertised" },
      transport: {
        type: "file-response",
        response: { mediaTypes: ["application/pdf"] },
      },
      inputSchema: { body: { type: "object" } },
    };
    const earlier = {
      id: "widgets.alpha",
      unknownFutureField: { preserved: true },
    };
    withShards(
      {
        "widgets.zebra.json": JSON.stringify(later),
        "widgets.alpha.json": JSON.stringify(earlier),
      },
      (directory) => {
        expect(readCapabilityCatalog(directory)).toEqual([earlier, later]);
      },
    );
  });

  test("rejects misnamed or duplicate ids instead of silently shadowing them", () => {
    withShards(
      {
        "widgets.alpha.json": '{"id":"widgets.alpha"}',
        "widgets.beta.json": '{"id":"widgets.alpha"}',
      },
      (directory) => {
        expect(() => readCapabilityCatalog(directory)).toThrow(
          "widgets.beta.json has an invalid id",
        );
      },
    );
  });

  test("rejects malformed JSON and non-object shards", () => {
    withShards({ "widgets.alpha.json": "{" }, (directory) => {
      expect(() => readCapabilityCatalog(directory)).toThrow(SyntaxError);
    });
    for (const content of ["null", "[]", "42", '{"id":42}']) {
      withShards({ "widgets.alpha.json": content }, (directory) => {
        expect(() => readCapabilityCatalog(directory)).toThrow(
          "widgets.alpha.json has an invalid id",
        );
      });
    }
  });

  test("rejects files outside the capability naming convention", () => {
    withShards({ "README.md": "unexpected" }, (directory) => {
      expect(() => readCapabilityCatalog(directory)).toThrow(
        "Unexpected capability catalog shard: README.md",
      );
    });
  });
});

test("curated capability references fail when the registry snapshot loses their tool", () => {
  for (const mcp of [
    { type: "tool", name: "list_widgets" },
    { type: "covered", by: "list_widgets" },
  ]) {
    const entries = [{ id: "widgets.list", mcp }];
    checkCapabilityRegistry(entries, new Set(["list_widgets"]));
    expect(() => checkCapabilityRegistry(entries, new Set())).toThrow(
      "missing registry tool: list_widgets",
    );
  }
});
