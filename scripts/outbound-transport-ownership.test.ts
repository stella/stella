import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import type { OutboundTransportCensusEntry } from "./outbound-transport-census";
import {
  outboundTransportReferences,
  readApiProductionSources,
  validateOutboundTransportCensus,
} from "./outbound-transport-ownership";

const API_SOURCE = "apps/api/src/handlers/census-fixture.ts";

const references = (text: string, file = API_SOURCE): string[] =>
  outboundTransportReferences({ file, text });

const validateAtJsonBoundary = (options: unknown): unknown =>
  Reflect.apply(validateOutboundTransportCensus, undefined, [options]);

const censusEntry = ({
  path: owner,
  class: transportClass = "third-party",
  reason = "Keeps the request path in its owning boundary.",
  transports,
}: {
  path: OutboundTransportCensusEntry["path"];
  class?: OutboundTransportCensusEntry["class"];
  reason?: string;
  transports: readonly string[];
}): OutboundTransportCensusEntry => ({
  path: owner,
  class: transportClass,
  reason,
  transports,
});

describe("outbound transport ownership", () => {
  test("global request forms have one outbound capability", () => {
    const forms = [
      "void fetch(url);",
      "void globalThis.fetch(url);",
      "void self.fetch(url);",
      "void window.fetch(url);",
      'void globalThis["fetch"](url);',
      "const request = fetch; void request(url);",
      "const request = globalThis.fetch; void request(url);",
      "const { fetch: request } = globalThis; void request(url);",
    ] as const;

    assertProperty(
      "global request forms have one outbound capability",
      fc.property(fc.constantFrom(...forms), (text) => {
        expect(references(text)).toEqual(["global:fetch"]);
      }),
    );
  });

  test("local request bindings have no outbound capability", () => {
    const shadowedForms = [
      "const fetch = (url: string) => url; void fetch(input);",
      "function read(fetch: (url: string) => unknown) { return fetch(input); }",
      "const globalThis = { fetch: (url: string) => url }; void globalThis.fetch(input);",
      "const self = { fetch: (url: string) => url }; void self.fetch(input);",
      "const window = { fetch: (url: string) => url }; void window.fetch(input);",
    ] as const;

    assertProperty(
      "local request bindings have no outbound capability",
      fc.property(fc.constantFrom(...shadowedForms), (text) => {
        expect(references(text)).toEqual([]);
      }),
    );
  });

  test("finds platform request constructors", () => {
    expect(references("void Bun.fetch(url);")).toEqual(["global:Bun.fetch"]);
    expect(references("void new WebSocket(url);")).toEqual([
      "global:WebSocket",
    ]);
    expect(references("new EventSource(url);")).toEqual(["global:EventSource"]);
    expect(references("new Bun.RedisClient(url);")).toEqual([
      "global:Bun.RedisClient",
    ]);
  });

  test("finds runtime module loads and ignores type-only declarations", () => {
    const runtimeForms = [
      'import { request } from "undici";',
      'export { request } from "node:https";',
      'const client = await import("node:http");',
      'const client = require("undici");',
    ] as const;

    for (const text of runtimeForms) {
      expect(references(text)).not.toEqual([]);
    }
    expect(references('import type { Dispatcher } from "undici";')).toEqual([]);
    expect(
      references('export type { ClientRequest } from "node:http";'),
    ).toEqual([]);
  });

  test("platform utilities retain their local-only classification", () => {
    for (const source of [
      'import { isIP, BlockList } from "node:net";',
      'import { file, Glob } from "bun";',
      'import { DelayedError } from "bullmq";',
      'import { jwtVerify, SignJWT } from "jose";',
    ]) {
      expect(references(source)).toEqual([]);
    }
  });

  test("default client imports retain authority beside named utilities", () => {
    expect(references('import runtime, { file } from "bun";')).toEqual([
      "module:bun",
    ]);
    expect(references('import queue, { DelayedError } from "bullmq";')).toEqual(
      ["module:bullmq"],
    );
  });

  test("reports module capabilities in sorted unique order", () => {
    expect(
      references(
        [
          'import { request } from "node:https";',
          'import { fetch } from "undici";',
          'export { get } from "node:https";',
          "void fetch(url);",
        ].join("\n"),
      ),
    ).toEqual(["module:node:https", "module:undici"]);
  });

  test("runtime imports retain their module capability", () => {
    const specifiers = [
      "undici",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "node:dgram",
      "@mistralai/mistralai",
      "bullmq",
      "mailauth",
      "jose",
    ] as const;
    assertProperty(
      "runtime imports retain their module capability",
      fc.property(fc.constantFrom(...specifiers), (specifier) => {
        expect(
          references(`import * as client from ${JSON.stringify(specifier)};`),
        ).toEqual([`module:${specifier}`]);
      }),
    );
  });

  test("finds runtime imports of the permit grant outside a listed owner", () => {
    expect(
      references(
        'import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";',
      ),
    ).toEqual(["permit:grant"]);
    expect(
      references(
        'import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";',
      ),
    ).toEqual([]);
  });

  test("reports API sources outside the census", () => {
    const sources = new Map([[API_SOURCE, "void fetch(url);"]]);
    const errors = validateOutboundTransportCensus({
      sources,
      census: [],
      grantOwners: [],
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain(API_SOURCE);
    expect(errors.join("\n")).toContain("transport census differs");
  });

  test("enumerates API source dialects and reports a planted transport", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-outbound-owner-"));
    const files = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"].map(
      (extension) => `apps/api/src/handlers/census-fixture.${extension}`,
    );
    try {
      for (const file of files) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await Bun.write(path.join(root, file), "void fetch(url);");
      }
      const sources = readApiProductionSources(root);
      expect([...sources.keys()].toSorted()).toEqual(files.toSorted());
      const problems = validateOutboundTransportCensus({
        sources,
        census: [],
        grantOwners: [],
      });
      expect(problems).toHaveLength(files.length);
      for (const file of files) {
        expect(problems).toContain(
          `${file}: transport census differs (observed global:fetch; declared )`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a census entry that accounts for every observed capability", () => {
    const sources = new Map([
      [API_SOURCE, 'import { request } from "undici"; void request(url);'],
    ]);
    const census = [
      censusEntry({ path: API_SOURCE, transports: ["module:undici"] }),
    ];

    expect(
      validateOutboundTransportCensus({ sources, census, grantOwners: [] }),
    ).toEqual([]);
  });

  test("reports stale census rows whose source has no matching capability", () => {
    const sources = new Map([[API_SOURCE, "export const ready = true;"]]);
    const census = [
      censusEntry({ path: API_SOURCE, transports: ["global:fetch"] }),
    ];

    const errors = validateOutboundTransportCensus({
      sources,
      census,
      grantOwners: [],
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain(API_SOURCE);
    expect(errors.join("\n")).toContain("stale transport entry");
  });

  test("rejects unknown transport names and census classes", () => {
    const otherSource = "apps/api/src/handlers/other-fixture.ts";
    const sources = new Map([
      [API_SOURCE, "export const ready = true;"],
      [otherSource, "export const ready = true;"],
    ]);
    const errors = validateAtJsonBoundary({
      sources,
      census: [
        {
          path: API_SOURCE,
          class: "third-party",
          reason: "Keeps the request path in its owning boundary.",
          transports: ["module:unknown-client"],
        },
        {
          path: otherSource,
          class: "unlisted-class",
          reason: "Keeps the request path in its owning boundary.",
          transports: ["global:fetch"],
        },
      ],
      grantOwners: [],
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unknown transport class unlisted-class"),
        expect.stringContaining("module:unknown-client"),
      ]),
    );
  });

  test("accepts a grant import in a declared owner", () => {
    const owner = "apps/api/src/mcp/permit-owner.ts";
    const source =
      'import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";';
    const sources = new Map([[owner, source]]);
    expect(
      validateOutboundTransportCensus({
        sources,
        census: [],
        grantOwners: [
          {
            path: owner,
            reason: "Creates a permit at the direct request boundary.",
          },
        ],
      }),
    ).toEqual([]);
  });

  test("reports a grant owner with no matching grant import", () => {
    const sources = new Map([[API_SOURCE, "export const ready = true;"]]);

    const errors = validateOutboundTransportCensus({
      sources,
      census: [],
      grantOwners: [
        {
          path: API_SOURCE,
          reason: "Creates a permit at the direct request boundary.",
        },
      ],
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain(API_SOURCE);
  });
});
