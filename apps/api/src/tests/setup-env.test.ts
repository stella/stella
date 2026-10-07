import { expect, test } from "bun:test";

import { envApiServerSchema } from "@/api/env-schema";

// These keys authenticate non-model services; keep their fixtures independent.
const nonModelKeys = new Set([
  "TAVILY_API_KEY",
  "JINA_API_KEY",
  "COMPANIES_HOUSE_API_KEY",
  "HOSTED_USAGE_PROVIDER_API_KEY",
  "AGENT_SANDBOX_HARNESS_API_KEY",
]);
const providerCredentials = Object.keys(envApiServerSchema).filter(
  (name) =>
    (name.endsWith("_API_KEY") && !nonModelKeys.has(name)) ||
    name.startsWith("GOOGLE_AI_API_KEY_") ||
    name.startsWith("OPENROUTER_WIF_"),
);
// Google's SDK also accepts this alias without going through the API schema.
providerCredentials.push("GOOGLE_API_KEY");

test("test preload removes inherited model credentials before imports", async () => {
  const inherited = Object.fromEntries(
    providerCredentials.map((name) => [name, "inherited-fixture-credential"]),
  );
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--preload",
      new URL("setup-env.ts", import.meta.url).pathname,
      "--eval",
      `console.log(JSON.stringify(${JSON.stringify(providerCredentials)}.map(name => process.env[name] ?? null)))`,
    ],
    cwd: new URL("../../", import.meta.url).pathname,
    env: { ...process.env, ...inherited },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(errors).toBe("");
  expect(status).toBe(0);
  expect(JSON.parse(output)).toEqual(providerCredentials.map(() => null));
});
