import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { assessMeasurements, RATCHET_METRICS } from "./ratchet";
import {
  countUnsignalledSkips,
  isExcludedSkipSource,
} from "./unsignalled-skip";

const count = (content: string) =>
  countUnsignalledSkips(content, { file: "apps/api/src/example.ts" });

describe("unsignalled skip shapes", () => {
  const retentionCases = [
    ["collection insertion", "kept.push(row);", "kept.push(other);"],
    ["set value", "groups.set(key, [row]);", "groups.set(row, [other]);"],
    ["set member", "kept.add(row);", "kept.add(other);"],
    [
      "nested collection",
      "groups.set(key, { entries: [row] });",
      "groups.set(key, { entries: [other] });",
    ],
    ["assigned member", "kept[key] = row;", "kept[key] = other;"],
    [
      "retained alias",
      "const next = { entries: [row] }; kept.push(next);",
      "const next = { entries: [other] }; kept.push(next);",
    ],
  ] as const;
  for (const [name, retained, discarded] of retentionCases) {
    test(`${name} retains the current iteration value`, () => {
      const code = (retention: string) =>
        `for (const row of rows) { const group = groups.get(row.id); if (!group) { ${retention} continue; } }`;
      expect(count(code(retained))).toBe(0);
      expect(count(code(discarded))).toBe(1);
    });
  }
  for (const helper of [
    "retryableToolErrorResult",
    "gatewayLoadErrorResult",
    "loadFaultResult",
    "failureResponse",
    "forbidden",
    "rejectRecord",
    "failRequest",
    "accessDeniedResponse",
  ]) {
    test(`${helper} propagates a named failure outcome`, () => {
      expect(
        count(`try { read(); } catch (error) { return ${helper}(error); }`),
      ).toBe(0);
      expect(
        count(`try { read(); } catch (error) { ${helper}(error); return []; }`),
      ).toBe(1);
      expect(
        count(
          `function* results() { try { read(); } catch (error) { yield ${helper}(error); } }`,
        ),
      ).toBe(0);
    });
  }
  test("injected error callbacks observe the failure on the exit path", () => {
    expect(
      count(
        "function read({ onRedisError }) { try { fetch(); } catch (error) { onRedisError(error); return []; } }",
      ),
    ).toBe(0);
    expect(
      count(
        "function read({ onRedisError }) { try { fetch(); } catch (error) { if (debug) onRedisError(error); return []; } }",
      ),
    ).toBe(1);
  });
  test("local wrappers propagate throws", () => {
    expect(
      count(
        "const rethrow = error => { throw error; }; try { read(); } catch (error) { rethrow(error); }",
      ),
    ).toBe(0);
    expect(
      count(
        "const rethrow = error => { if (debug) throw error; }; try { read(); } catch (error) { rethrow(error); }",
      ),
    ).toBe(1);
  });
  test("collections retain classified failure outcomes", () => {
    expect(
      count(
        "for (const row of rows) { const parsed = parseRow(row); if (!parsed.success) { rejected.push(rejection(row)); continue; } }",
      ),
    ).toBe(0);
    expect(
      count(
        'for (const row of rows) { const parsed = parseRow(row); if (!parsed.success) { outcomes.set(row.id, { type: "rejected" }); continue; } }',
      ),
    ).toBe(0);
    expect(
      count(
        "for (const row of rows) { const parsed = parseRow(row); if (!parsed.success) { rejected.push(render(row)); continue; } }",
      ),
    ).toBe(1);
  });
  test("optional failure outcomes leave an unsignalled path", () => {
    expect(
      count(
        "try { read(); } catch (error) { return failureResponse?.(error); }",
      ),
    ).toBe(1);
    expect(
      count(
        "try { read(); } catch (error) { return responses?.failureResponse(error); }",
      ),
    ).toBe(1);
  });
  for (const method of ["close", "cancel", "enqueue"]) {
    test(`controller ${method} cleanup tolerates concurrent completion`, () => {
      const code = (body: string) =>
        `function cleanup(controller: ReadableStreamDefaultController<Uint8Array>) { try { ${body} } catch {} }`;
      expect(count(code(`controller.${method}();`))).toBe(0);
      expect(count(code(`read(); controller.${method}();`))).toBe(1);
      expect(count(`try { controller.${method}(); } catch {}`)).toBe(1);
      expect(
        count(
          code(`controller.${method}();`).replace(
            "catch {}",
            "catch { return []; }",
          ),
        ),
      ).toBe(1);
    });
  }
  const retentionGaps = [
    "if (debug) kept.push(row);",
    "kept?.push(row);",
    "kept.push?.(row);",
    "const deferred = () => kept.push(row);",
    "kept.push(transform(row));",
    "kept.push(row.id);",
    "text += row;",
    "let alias = row; alias = other; kept.push(alias);",
    "const alias = { row }; alias.row = other; kept.push(alias);",
    "const row = other; kept.push(row);",
  ];
  for (const retention of retentionGaps) {
    test(`conditional or transformed retention: ${retention}`, () => {
      expect(
        count(
          `for (const row of rows) { const item = table.get(row.id); if (!item) { ${retention} continue; } }`,
        ),
      ).toBe(1);
    });
  }
  const scopeGaps = [
    "for (const { id } of rows) { const item = table.get(id); if (!item) { kept.push(id); continue; } }",
    "function read({ onRedisError }) { { const onRedisError = () => {}; try { fetch(); } catch (error) { onRedisError(error); return []; } } }",
    "function read({ onRedisError }) { onRedisError = () => {}; try { fetch(); } catch (error) { onRedisError(error); return []; } }",
    "function cleanup(controller: ReadableStreamDefaultController<Uint8Array>) { try { controller.enqueue(read()); } catch {} }",
    "function cleanup(controller: ReadableStreamDefaultController<Uint8Array>) { { const controller = service; try { controller.close(); } catch {} } }",
    "const failureResponse = () => []; try { read(); } catch (error) { return failureResponse(error); }",
    "function* results() { try { read(); } catch (error) { yield failureResponse?.(error); } }",
  ];
  for (const code of scopeGaps) {
    test(`lexical and evaluation boundaries: ${code}`, () =>
      expect(count(code)).toBe(1));
  }
  const counted = [
    [
      "catch allowance after ordinary work is not catch scoped",
      "try { read(); } catch { cleanup();\n // unsignalled-skip-allow: optional cleanup\n return []; }",
    ],
    [
      "cyclic helper without an observation",
      "const report = cause => report(cause); try { read(); } catch { report(cause); }",
    ],
    [
      "optional logger receiver",
      "try { read(); } catch { logger?.warn(cause); }",
    ],
    [
      "result error method drops row",
      "for (const row of rows) { const parsed = parseRow(row); if (parsed.isErr()) continue; }",
    ],
    [
      "result error factory drops row",
      "for (const row of rows) { const parsed = Result.try(() => parseRow(row)); if (Result.isError(parsed)) continue; }",
    ],
    [
      "compound failed parse predicate",
      "for (const row of rows) { const parsed = parseRow(row); if (!parsed.success && shouldSkip) continue; }",
    ],
    [
      "filter rejects parse error property",
      "rows.filter(row => !parseRow(row).error);",
    ],
    [
      "filter rejects result error predicate",
      "rows.filter(row => !Result.isError(parseRow(row)));",
    ],
    [
      "adapter rejects a malformed stored row",
      "async function importRows(rows) { const imported = []; for (const row of rows) { const parsed = rowSchema.safeParse(row); if (!parsed.success) continue; imported.push(parsed.data); } return imported; }",
    ],
    [
      "stored item fetch returns empty collection",
      "async function listStoredRows() { return await fetchStoredRows().catch(() => []); }",
    ],
    [
      "extracted response body uses empty text",
      'async function readBody(payload) { return { type: "body", body: parseBody(payload.raw) ?? "" }; }',
    ],
    [
      "nullable record lookup uses empty object",
      "return lookupRecord(recordId) || {};",
    ],
    [
      "map extraction uses empty collection",
      "const groups = new Map(); return groups.get(id) ?? [];",
    ],
    [
      "adapter filters failed row parses",
      "return sourceRows.filter(row => { const parsed = parseRow(row); return parsed.success; });",
    ],
    [
      "catch with short circuit telemetry",
      "try { read(); } catch { debug && logger.error(cause); }",
    ],
    [
      "catch with conditional telemetry",
      "try { read(); } catch { debug ? logger.error(cause) : undefined; }",
    ],
    [
      "catch with optional telemetry",
      "try { read(); } catch { captureException?.(cause); }",
    ],
    [
      "lookup skipped in else arm",
      "for (const row of rows) { const item = table.get(row.id); if (item) use(item); else continue; }",
    ],
    [
      "parse result alias skipped",
      "for (const row of rows) { const parsed = schema.safeParse(row); const success = parsed.success; if (!success) continue; }",
    ],
    [
      "filter with block parse predicate",
      "rows.filter(row => { const parsed = schema.safeParse(row); return parsed.success; });",
    ],
    ["catch without signal", "try { read(); } catch (cause) {}"],
    ["catch returning empty text", 'try { read(); } catch { return ""; }'],
    ["catch with ordinary work", "try { read(); } catch { cleanup(); }"],
    [
      "catch with deferred telemetry",
      "try { read(); } catch { const report = () => logger.error(cause); }",
    ],
    [
      "catch with a signal in one branch",
      "try { read(); } catch { if (debug) logger.error(cause); }",
    ],
    [
      "catch with one empty return",
      "try { read(); } catch { if (debug) return Result.err(cause); return []; }",
    ],
    [
      "nullable computed value skipped",
      "for (const item of items) { const head = sentenceHeadPattern(item.text); if (head === null) { continue; } use(head); }",
    ],
    [
      "empty text extraction fallback",
      'return { kind: "windowed-text", text: asString(valueAtPath(payload, textPath)) ?? "", nextCursor: asString(fieldOf(payload, "nextCursor")) };',
    ],
    [
      "lookup skipped",
      "for (const row of rows) { const item = table.get(row.id); if (!item) continue; use(item); }",
    ],
    [
      "parse failure skipped",
      "for (const row of rows) { const parsed = schema.safeParse(row); if (!parsed.success) { continue; } }",
    ],
    [
      "filter rejects failed parse",
      "rows.filter(row => { const parsed = schema.safeParse(row); if (!parsed.success) return false; return true; });",
    ],
    [
      "filter with direct parse predicate",
      "rows.filter(row => schema.safeParse(row).success);",
    ],
    [
      "filter with lookup predicate",
      "rows.filter(row => Boolean(table.get(row.id)));",
    ],
    [
      "sibling signal before lookup failure branch",
      "for (const row of rows) { const item = table.get(row.id); if (debug) logger.warn(row); if (!item) continue; }",
    ],
    [
      "nested callback in skip branch",
      "for (const row of rows) { const item = table.get(row.id); if (!item) { const report = () => logger.warn(row); continue; } }",
    ],
    [
      "empty allowance reason",
      "read().catch(() => undefined); // unsignalled-skip-allow:   ",
    ],
    [
      "allowance on adjacent line",
      "// unsignalled-skip-allow: reason\nread().catch(() => undefined);",
    ],
    [
      "allowance inside a string",
      'read().catch(() => "// unsignalled-skip-allow: reason");',
    ],
    [
      "block comment allowance",
      "read().catch(() => undefined); /* unsignalled-skip-allow: reason */",
    ],
  ] as const;
  for (const [name, code] of counted) {
    test(name, () => expect(count(code)).toBe(1));
  }

  for (const empty of ["undefined", "null", "[]", "{}", '""', "void 0"]) {
    test(`promise catch returning ${empty}`, () => {
      expect(count(`read().catch(() => (${empty}));`)).toBe(1);
      expect(count(`read().catch((() => (${empty})));`)).toBe(1);
      expect(count(`read().catch(function () { return ${empty}; });`)).toBe(1);
    });
  }

  const sanctioned = [
    [
      "formatter catch body allowance",
      "try { read(); } catch {\n // unsignalled-skip-allow: optional field\n return []; }",
    ],
    [
      "multiline promise allowance",
      "read()\n.catch( // unsignalled-skip-allow: optional cache\n () => undefined\n);",
    ],
    [
      "multiline extraction allowance",
      'return parseBody(raw)\n ?? ""; // unsignalled-skip-allow: optional field',
    ],
    [
      "hoisted typed failure helper",
      "try { read(); } catch { return toFailure(cause); } function toFailure(cause) { return Result.err(cause); }",
    ],
    [
      "local telemetry helper",
      "const report = cause => { captureException(cause); }; try { read(); } catch { report(cause); }",
    ],
    [
      "typed issue code constant",
      "for (const row of rows) { const parsed = parseRow(row); if (!parsed.success) { issues.push({ code: FAILURE_CODES.invalid, row }); continue; } }",
    ],
    ["arbitrary function fallback", "return getSettings() ?? {};"],
    ["ordinary array default", "return rows ?? [];"],
    ["primitive optional field default", 'return payload.optionalLabel ?? "";'],
    [
      "nullable fallback is a domain absence",
      "return valueAtPath(payload, path) ?? null;",
    ],
    [
      "adapter records rejected row telemetry",
      "for (const row of rows) { const parsed = rowSchema.safeParse(row); if (!parsed.success) { observeFailure(parsed.error); continue; } imported.push(parsed.data); }",
    ],
    [
      "adapter records a typed issue",
      'for (const row of rows) { const parsed = rowSchema.safeParse(row); if (!parsed.success) { issues.push({ code: "invalid-row", row }); continue; } imported.push(parsed.data); }',
    ],
    [
      "stored row fetch propagates rejection",
      "return await fetchStoredRows().catch(cause => { throw cause; });",
    ],
    [
      "stored row fetch returns a typed result",
      "return await fetchStoredRows().catch(cause => Result.err(cause));",
    ],
    [
      "stored row fetch returns a discriminated outcome",
      'return await fetchStoredRows().catch(cause => ({ status: "failed", cause }));',
    ],
    [
      "extraction fallback has a reason",
      'return parseBody(raw) ?? ""; // unsignalled-skip-allow: optional description field',
    ],
    [
      "switch rethrow",
      "try { read(); } catch (cause) { switch (mode) { case 'one': throw cause; default: throw cause; } }",
    ],
    [
      "continue after a successful parse",
      "for (const row of rows) { const parsed = schema.safeParse(row); if (parsed.success) continue; }",
    ],
    [
      "parameter shadows a lookup",
      "const item = table.get(id); function process(item) { for (const row of rows) { if (!item) continue; } }",
    ],
    [
      "aliased telemetry import",
      "import { captureError as report } from '@/api/lib/analytics/capture'; try { read(); } catch { report(cause); }",
    ],
    ["rethrow", "try { read(); } catch (cause) { throw cause; }"],
    [
      "result return",
      "try { read(); } catch (cause) { return Result.err(cause); }",
    ],
    [
      "result produced",
      "try { read(); } catch (cause) { outcome = Result.err(cause); }",
    ],
    [
      "discriminated return",
      'try { read(); } catch { return { status: "failed", cause }; }',
    ],
    [
      "failure record return",
      "try { read(); } catch { return { ok: false, cause }; }",
    ],
    [
      "telemetry then fallback",
      "read().catch(cause => { captureException(cause); return undefined; });",
    ],
    [
      "conditional rethrow and telemetry",
      "try { read(); } catch { if (fatal) throw cause; else captureException(cause); }",
    ],
    [
      "reasoned inline allowance",
      "read().catch(() => undefined); // unsignalled-skip-allow: optional cache entry",
    ],
    [
      "reasoned catch allowance",
      "try { read(); } catch { // unsignalled-skip-allow: optional cache entry\n}",
    ],
    [
      "skip logged in branch",
      "for (const row of rows) { const item = table.get(row.id); if (!item) { logger.warn(row); continue; } }",
    ],
    [
      "skip counted in branch",
      "for (const row of rows) { const item = table.get(row.id); if (!item) { skipped += 1; continue; } }",
    ],
    [
      "skip record in branch",
      'for (const row of rows) { const item = table.get(row.id); if (!item) { outcomes.push({ type: "skipped", row }); continue; } }',
    ],
    [
      "filter with signal",
      "rows.filter(row => { const item = table.get(row.id); if (!item) { captureException(row); return false; } return true; });",
    ],
    ["ordinary selection filter", "rows.filter(row => row.active);"],
    [
      "ordinary iteration control",
      "for (const row of rows) { if (row.hidden) continue; }",
    ],
    [
      "unrelated same name in another function",
      "function first() { const item = table.get(id); } function second() { for (const row of rows) { if (!item) continue; } }",
    ],
    ["test string containing catch", 'const sample = "try {} catch {}";'],
    [
      "result catch option",
      "Result.tryPromise({ try: () => read(), catch: cause => cause });",
    ],
  ] as const;
  for (const [name, code] of sanctioned) {
    test(name, () => expect(count(code)).toBe(0));
  }

  for (const helper of [
    "captureException",
    "captureError",
    "captureRequestError",
    "captureObservedError",
    "captureRedactedException",
    "captureRouteErrorLifecycle",
    "recordRequestFailure",
    "reportEmitFailure",
    "reportFatalError",
    "emitAdmissionStorePolicyMetric",
    "emitRequestDurationMetric",
    "emitOpenRouterTokenExchange",
    "emitManagedCredentialUnavailable",
    "emitFailureMetric",
    "emitChatRunLogMetric",
    "emitPromptCacheMetric",
    "emitActionCostDropMetric",
    "emitChatTurnSettlementMetric",
    "emitAnonymizationRefusalMetric",
    "emitPublicCorpusAdmissionMetric",
    "emitActionResponseOversizeMetric",
  ]) {
    test(`observation helper ${helper}`, () =>
      expect(count(`try { read(); } catch (cause) { ${helper}(cause); }`)).toBe(
        0,
      ));
  }
  for (const signal of [
    "logger.warn(cause)",
    "console.error(cause)",
    "failureCounter.inc()",
    "metrics.record(cause)",
    "skipped++",
  ]) {
    test(`observation expression ${signal}`, () =>
      expect(count(`try { read(); } catch (cause) { ${signal}; }`)).toBe(0));
  }

  test("sites are counted independently", () => {
    expect(
      count(
        "try { read(); } catch {}\nread().catch(() => []);\nfor (const row of rows) { const item = table.get(row.id); if (!item) continue; }",
      ),
    ).toBe(3);
  });

  test("production source exclusions", () => {
    for (const file of [
      "apps/api/src/a.test.ts",
      "apps/web/src/tests/a.ts",
      "packages/a/src/fixtures/a.ts",
      "apps/desktop/scripts/a.ts",
      "packages/a/src/generated/a.ts",
      "packages/a/src/a.generated.ts",
      "apps/web/src/a.gen.ts",
      "packages/a/src/a.d.ts",
    ]) {
      expect(isExcludedSkipSource(file)).toBe(true);
    }
    expect(isExcludedSkipSource("packages/a/src/a.ts")).toBe(false);
  });

  test("registry rejects increases per file without allowances", () => {
    const metric =
      RATCHET_METRICS.find(({ id }) => id === "unsignalled-skip") ??
      panic("Metric absent");
    expect(metric.perFile).toBe(true);
    expect(metric.growth).toBe("shrink-only");
    expect(
      assessMeasurements({
        metrics: [metric],
        current: { [metric.id]: { count: 1, files: { "b.ts": 1 } } },
        baseline: { [metric.id]: { count: 1, files: { "a.ts": 1 } } },
      }).diffs.at(0)?.status,
    ).toBe("regressed");
  });
});
