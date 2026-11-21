import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("reports direct request access at each binding", async () => {
  expect(
    await lintSingleRule(
      "confine-server-reads",
      'import { getCookie as readCookie } from "@tanstack/react-start/server";\nimport { getRequestHeader as readHeader } from "@tanstack/react-start/server";',
    ),
  ).toEqual([1, 2]);
});

test("reports request access through namespace and dynamic bindings", async () => {
  expect(
    await lintSingleRule(
      "confine-server-reads",
      'import * as server from "@tanstack/react-start/server";\nserver["getRequestHeaders"]();\nconst { getRequest } = await import("@tanstack/react-start/server");',
    ),
  ).toEqual([2, 3]);
});

test("allows approved server helpers and unrelated local accessors", async () => {
  expect(
    await lintSingleRule(
      "confine-server-reads",
      'import { getRequestHost } from "@tanstack/react-start/server";\ngetRequestHost();\nconst local = { getCookie: () => "locale" };\nlocal.getCookie();',
    ),
  ).toEqual([]);
});

test("request-boundary owners can read cookies while route modules cannot", async () => {
  const source =
    'import { getCookie } from "@tanstack/react-start/server";\ngetCookie("presentation");';
  expect(
    await lintSingleRule("confine-server-reads", source, {
      sourcePath: "apps/web/src/lib/account/presentation-prefs/server.ts",
    }),
  ).toEqual([]);
  expect(
    await lintSingleRule("confine-server-reads", source, {
      sourcePath: "apps/web/src/routes/__root.tsx",
    }),
  ).toEqual([1]);
});

test("the API forwarding boundary can read headers without exposing access to consumers", async () => {
  const source =
    'import { getRequestHeader } from "@tanstack/react-start/server";\ngetRequestHeader("cookie");';
  expect(
    await lintSingleRule("confine-server-reads", source, {
      sourcePath: "apps/web/src/lib/account/ssr-api-headers.ts",
    }),
  ).toEqual([]);
  expect(
    await lintSingleRule("confine-server-reads", source, {
      sourcePath: "apps/web/src/lib/api-request-context.ts",
    }),
  ).toEqual([1]);
});

test("request scenarios share the web framework's error-preserving test owner", async () => {
  const source =
    'import { requestHandler } from "@tanstack/react-start/server";\nrequestHandler(async () => new Response(null));';
  const sourcePaths = [
    "apps/web/src/routes/law/-statutes-index.logic.test.ts",
    "apps/api/src/tests/helpers/chat-web-client.ts",
  ];
  expect(
    await Promise.all(
      sourcePaths.map(
        async (sourcePath) =>
          await lintSingleRule("confine-server-reads", source, { sourcePath }),
      ),
    ),
  ).toEqual([[1], [1]]);
  expect(
    await lintSingleRule("confine-server-reads", source, {
      sourcePath: "apps/web/src/testing/request-test.ts",
    }),
  ).toEqual([]);
  expect(
    await lintSingleRule("confine-server-reads", source, {
      sourcePath: "packages/test-kit/src/request.ts",
    }),
  ).toEqual([1]);
  expect(
    await lintSingleRule(
      "confine-server-reads",
      'const { requestHandler } = await import("@tanstack/react-start/server");',
    ),
  ).toEqual([1]);
});
