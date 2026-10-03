import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { normalizeExternalMcpToolsForChat } from "@/api/handlers/chat/tools/external-mcp-tools-normalization";
import { isRecord } from "@/api/lib/type-guards";
import { ownJsonKey, ownKeyJsonObject } from "@/api/tests/helpers/own-key-json";

test("external tool normalization retains every schema property name", () => {
  assertProperty(
    "external tool normalization retains every schema property name",
    fc.property(
      fc.uniqueArray(ownJsonKey, { maxLength: 8 }),
      fc.constantFrom("json-schema", "openapi"),
      (keys, nullUnionStrategy) => {
        const names = [...new Set([...keys, "__proto__", "constructor"])];
        const properties = Object.fromEntries(
          names.map((name) => [name, { type: "string" }]),
        );
        const schema = { type: "object", properties, required: names };
        const normalized = normalizeExternalMcpToolsForChat({
          allowedTools: null,
          connectorSlug: "fixture",
          nullUnionStrategy,
          tools: [
            {
              name: "lookup",
              description: "Lookup",
              inputSchema: schema,
              outputSchema: schema,
            },
          ],
        });
        const exposed = normalized.tools["mcp__fixture__lookup"];
        expect(exposed).toBeDefined();
        for (const projected of [exposed?.inputSchema, exposed?.outputSchema]) {
          expect(isRecord(projected)).toBe(true);
          if (!isRecord(projected) || !isRecord(projected.properties)) {
            panic("expected an object schema with properties");
          }
          expect(Object.keys(projected.properties).toSorted()).toEqual(
            names.toSorted(),
          );
          expect(projected.required).toEqual(names);
          for (const name of names) {
            expect(Object.hasOwn(projected.properties, name)).toBe(true);
            expect(projected.properties[name]).toEqual({ type: "string" });
          }
        }
      },
    ),
  );
});

test("external tool normalization retains every execution input entry", async () => {
  await assertProperty(
    "external tool normalization retains every execution input entry",
    fc.asyncProperty(ownKeyJsonObject({ nulls: true }), async (input) => {
      const args = Object.fromEntries([
        ...Object.entries(input),
        ["__proto__", input],
        ["constructor", input],
      ]);
      const originalArgs = structuredClone(args);
      const calls: unknown[] = [];
      const normalized = normalizeExternalMcpToolsForChat({
        allowedTools: null,
        connectorSlug: "fixture",
        nullUnionStrategy: "json-schema",
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            execute: (value: unknown) => {
              calls.push(value);
              return "complete";
            },
          },
        ],
      });
      await normalized.tools["mcp__fixture__lookup"]?.execute?.(
        args,
        undefined,
      );
      expect(calls).toEqual([originalArgs]);
      expect(args).toEqual(originalArgs);
      for (const value of [...calls, args]) {
        expect(isRecord(value)).toBe(true);
        if (!isRecord(value)) {
          panic("expected object execution input");
        }
        expect(Object.hasOwn(value, "__proto__")).toBe(true);
        expect(Object.hasOwn(value, "constructor")).toBe(true);
      }
    }),
  );
});
