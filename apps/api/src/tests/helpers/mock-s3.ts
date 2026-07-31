import { mock } from "bun:test";

/**
 * A complete stand-in for the storage module.
 *
 * `mock.module` replaces a module wholesale, so a factory that names only the
 * exports its own test asserts on leaves every other export unresolvable — not
 * for that test alone, but for anything in the batch's import graph that
 * imports one. It surfaces as `SyntaxError: Export named ... not found`, kills
 * the file rather than an assertion, and moves between runs with batch
 * composition, so the test that fails is rarely the test at fault.
 *
 * Building the mock from the real module's own shape makes that unrepresentable:
 * an export added later is carried automatically and can never go missing.
 * Everything that touches storage is then stubbed on top, so the default is
 * inert rather than real — spreading alone would hand back live writes and
 * deletes to tests that never asked for them.
 *
 * Pass only what the test actually asserts on:
 *
 *   void mock.module("@/api/lib/s3", () =>
 *     mockS3Module({ getS3: () => ({ delete: deleteMock }) }),
 *   );
 */

const realS3 = await import("@/api/lib/s3");

type S3Module = typeof realS3;

/**
 * Override keys are checked against the real module, so a typo cannot quietly
 * add a export that nothing reads. Values are not: a test stubs only the few
 * client methods its own path calls, and requiring the full client type back
 * would make every such stub unwritable.
 */
type S3ModuleOverrides = { [K in keyof S3Module]?: unknown };

/** A storage client with every method stubbed, for tests that name none. */
const inertClient = () => ({
  delete: mock(() => Promise.resolve(undefined)),
  write: mock(() => Promise.resolve(undefined)),
  file: mock(() => ({
    arrayBuffer: mock(() => Promise.resolve(new ArrayBuffer(0))),
    text: mock(() => Promise.resolve("")),
  })),
});

export const mockS3Module = (overrides: S3ModuleOverrides = {}) => ({
  ...realS3,
  // Every export that reaches storage, neutralised. A test that cares passes
  // its own; a test that does not cannot accidentally hit a real bucket.
  getS3: inertClient,
  getCorpusS3: inertClient,
  deleteS3ObjectWithSignal: mock(() => Promise.resolve(undefined)),
  putS3ObjectWithSignal: mock(() => Promise.resolve(undefined)),
  refreshS3: mock(() => undefined),
  refreshCorpusS3: mock(() => undefined),
  presignDownloadUrl: mock(() =>
    Promise.resolve("https://example.test/presigned"),
  ),
  ...overrides,
});
