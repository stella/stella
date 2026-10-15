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
  const counted = [
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
    [
      "discarded result error",
      "try { read(); } catch (cause) { Result.err(cause); }",
    ],
    [
      "discarded result try",
      "try { read(); } catch (cause) { Result.try(() => cleanup()); }",
    ],
    [
      "discarded typed result helper",
      "const failure = cause => Result.err(cause); try { read(); } catch (cause) { failure(cause); }",
    ],
    [
      "success result fallback",
      "try { read(); } catch { return Result.ok([]); }",
    ],
    [
      "success-shaped record fallback",
      'try { read(); } catch { return { kind: "text", text: "" }; }',
    ],
    [
      "collected success record",
      'try { read(); } catch (cause) { imported.push({ type: "row", cause }); }',
    ],
    [
      "switch break then swallow",
      'try { read(); } catch (cause) { switch (kind) { case "a": cleanup(); break; } }',
    ],
    [
      "discarded hoisted typed result helper",
      "try { read(); } catch (cause) { toFailure(cause); } function toFailure(cause) { return Result.err(cause); }",
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
    [
      "typed record collected into an issue list",
      'for (const row of rows) { const found = items.find(match); if (found === undefined) { issues.push({ code: "unknown_source_id", row }); continue; } }',
    ],
    [
      "typed reason collected into a failure list",
      'for (const source of sources) { if (source.span === undefined) { failures.push({ id: source.id, reason: "span-out-of-bounds" }); continue; } }',
    ],
    [
      "switch break then rethrow",
      'try { read(); } catch (cause) { switch (kind) { case "a": cleanup(); break; } throw cause; }',
    ],
    [
      "default break then rethrow",
      "try { read(); } catch (cause) { switch (kind) { default: break; } throw cause; }",
    ],
    [
      "conditional switch break then rethrow",
      'try { read(); } catch (cause) { switch (kind) { case "a": if (done) { break; } cleanup(); break; } throw cause; }',
    ],
    [
      "returned result error",
      "try { read(); } catch (cause) { return Result.err(cause); }",
    ],
    [
      "returned typed result helper",
      "const failure = cause => Result.err(cause); try { read(); } catch (cause) { return failure(cause); }",
    ],
    [
      "collected result error",
      "for (const row of rows) { try { read(row); } catch (cause) { results.push(Result.err(cause)); } }",
    ],
    [
      "helper observes before building a result",
      "const failure = cause => { captureException(cause); return Result.err(cause); }; try { read(); } catch (cause) { failure(cause); }",
    ],
  ] as const;
  for (const [name, code] of sanctioned) {
    test(name, () => expect(count(code)).toBe(0));
  }

  for (const helper of [
    "logDocumentParseFailure",
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

  // Equality is symmetric: the literal's side must not change the arm.
  for (const [condition, expected] of [
    ["parsed.success === false", 1],
    ["false === parsed.success", 1],
    ["parsed.success == false", 1],
    ["false == parsed.success", 1],
    ["parsed.success !== true", 1],
    ["true !== parsed.success", 1],
    ["parsed.success != true", 1],
    ["true != parsed.success", 1],
    ["parsed.success === true", 0],
    ["true === parsed.success", 0],
    ["parsed.success !== false", 0],
    ["false !== parsed.success", 0],
  ] as const) {
    test(`boolean comparison ${condition}`, () =>
      expect(
        count(
          `for (const row of rows) { const parsed = schema.safeParse(row); if (${condition}) continue; }`,
        ),
      ).toBe(expected));
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
