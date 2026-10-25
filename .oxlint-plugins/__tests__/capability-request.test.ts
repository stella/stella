import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

// The rule resolves `@/lib/api` against the importing file, so each case is
// linted at a web source path, where the alias names the Eden client.
const lintWebSource = async (source: string) =>
  await lintSingleRule("capability-request", source, {
    sourcePath: "apps/web/src/capability-request-case.ts",
    cwd: "scratch",
  });

test("requires declared writes to forward the request and name a literal capability", async () => {
  expect(
    await lintWebSource(
      `
import { api as client } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { useCapabilityMutation } from "@/lib/capabilities/use-capability-mutation";
await invokeCapability("x.update", async () => await client.x({ id }).patch(body));
await invokeCapability(id, async (request) => await client.x.post(body, request));
await invokeCapability("x.update", async (request) => await client.x.post(body, { query }));
const route = client.x({ id });
await invokeCapability("x.delete", async (request) => await route.delete(body));
useCapabilityMutation({ capability: "x.create", mutationFn: async (vars) => await client.x.post(vars) });
useCapabilityMutation({ capability: name, mutationFn: async (vars, request) => await client.x.post(vars, request) });
`,
    ),
  ).toEqual([5, 6, 7, 9, 10, 11]);
});

test("reads the request from the options position, not the body", async () => {
  expect(
    await lintWebSource(
      `import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
await invokeCapability("x.delete", async (request) => await api.x({ id }).delete(request));
await invokeCapability("x.create", async (request) => await api.x.post(request));
await invokeCapability("x.delete", async (request) => await api.x({ id }).delete(undefined, request));
`,
    ),
  ).toEqual([3, 4]);
});

test("rejects a forwarded request whose headers are replaced after the spread", async () => {
  expect(
    await lintWebSource(
      `import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: {} }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, "headers": {} }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, ...extra }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, [key]: {} }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { headers: {}, ...request }));
`,
    ),
  ).toEqual([3, 4, 5, 6]);
});

test("accepts custom headers only when the exact request headers win last", async () => {
  expect(
    await lintWebSource(
      `import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { "Accept-Language": locale, ...request.headers } }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { locale, "x-format": format, ...request.headers }, fetch }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { ...request.headers, "x-stella-capability": "wrong" } }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { ...request.headers, ...extra } }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { ...other.headers } }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { ...request.headers }, ...extra }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: request.headers }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { "X-Stella-Capability": "wrong", ...request.headers } }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { ...extra, ...request.headers } }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { [key]: value, ...request.headers } }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { get custom() { return value; }, ...request.headers } }));
await invokeCapability("x.update", async (request) => await api.x.post(body, { ...request, headers: { custom() { return value; }, ...request.headers } }));
`,
    ),
  ).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
});

test("accepts forwarded requests and writes outside capability callbacks", async () => {
  expect(
    await lintWebSource(
      `import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { useCapabilityMutation } from "@/lib/capabilities/use-capability-mutation";
await invokeCapability("x.update", async (request) => await api.x({ id }).patch(body, request));
await invokeCapability("x.update", async (request) => await api.x.patch(body, { ...request, query }));
useCapabilityMutation({ capability: "x.create", mutationFn: async (vars, request) => await api.x.post(vars, request) });
await api.x.post(body);
await invokeCapability("x.read", async () => await api.x.get());
const map = new Map();
await invokeCapability("x.update", async (request) => map.delete(key));
`,
    ),
  ).toEqual([]);
});
