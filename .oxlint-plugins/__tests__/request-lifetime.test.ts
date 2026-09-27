import { describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(30_000);

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");

const lint = async (source: string) =>
  await lintSingleRule("confine-request-reads", source, {
    plugin: "request-lifetime",
    sourcePath: "apps/api/src/handlers/chat/example.ts",
  });

const lines = (...source: readonly string[]) => [...source, ""].join("\n");

describe.serial("request-lifetime confine-request-reads", () => {
  test("accepts the send handler as it stands", async () => {
    const source = await Bun.file(
      path.join(REPOSITORY_ROOT, "apps/api/src/handlers/chat/send-message.ts"),
    ).text();
    // The fixture must reach the rule: the handler reads its request and
    // hands the probe on.
    expect(source).toContain("request.signal.aborted");
    expect(source).toContain("isClientConnectionAborted,");
    expect(await lint(source)).toEqual([]);
  });

  test("reports a run callback that asks the request after the send returns", async () => {
    expect(
      await lint(
        lines(
          "export const send = async ({ request, start }: { request: Request; start: (f: () => void) => void }) => {",
          "  const isClientConnectionAborted = () => request.signal.aborted;",
          "  start(() => {",
          "    if (isClientConnectionAborted()) {",
          "      return;",
          "    }",
          "  });",
          "};",
        ),
      ),
    ).toEqual([4]);
  });

  test("reports the probe handed to a function that does not name it", async () => {
    expect(
      await lint(
        lines(
          "const later = (options: { check: () => boolean }) => options;",
          "export const send = ({ request }: { request: Request }) => {",
          "  const isClientConnectionAborted = () => request.signal.aborted;",
          "  return later({ check: isClientConnectionAborted });",
          "};",
        ),
      ),
    ).toEqual([4]);
  });

  test("reports the probe handed to a function that names it only in a type", async () => {
    expect(
      await lint(
        lines(
          "const later = (options: { isClientConnectionAborted: () => boolean }) => queueMicrotask(options.isClientConnectionAborted);",
          "export const send = ({ request }: { request: Request }) => {",
          "  const isClientConnectionAborted = () => request.signal.aborted;",
          "  later({ isClientConnectionAborted });",
          "};",
        ),
      ),
    ).toEqual([4]);
  });

  test("reports the probe handed on from a callback that runs later", async () => {
    expect(
      await lint(
        lines(
          "const check = ({ isClientConnectionAborted }: { isClientConnectionAborted: () => boolean }) => isClientConnectionAborted();",
          "export const send = ({ request, later }: { request: Request; later: (f: () => void) => void }) => {",
          "  const isClientConnectionAborted = () => request.signal.aborted;",
          "  later(() => check({ isClientConnectionAborted }));",
          "};",
        ),
      ),
    ).toEqual([4]);
  });

  test("reports a request read outside the probe", async () => {
    expect(
      await lint(
        lines(
          "export const send = ({ request }: { request: Request }) => {",
          "  const signal = request.signal;",
          "  return signal;",
          "};",
        ),
      ),
    ).toEqual([2]);
  });

  test("reports member reads but accepts write-only member targets", async () => {
    expect(
      await lint(
        lines(
          "export const send = (ctx: { request: Request }, next: Request, others: Request[]) => {",
          "  ctx.request = next;",
          "  for (ctx.request of others) {}",
          "  delete ctx.request;",
          "  return ctx.request.signal;",
          "};",
        ),
      ),
    ).toEqual([5]);
  });

  test("accepts nested destructuring targets but reports member values", async () => {
    expect(
      await lint(
        lines(
          "export const send = (ctx: { request: Request }, source: { value: Request }, others: { value: Request }[]) => {",
          "  ({ value: ctx.request } = source);",
          "  for ({ value: ctx.request } of others) {}",
          "  ({ value: ctx.request = source.value } = source);",
          "  [ctx.request] = [source.value];",
          "  ({ [ctx.request.url]: ignored } = source);",
          "  ctx.request ??= source.value;",
          "  return { value: ctx.request };",
          "};",
        ),
      ),
    ).toEqual([6, 7, 8]);
  });
});
