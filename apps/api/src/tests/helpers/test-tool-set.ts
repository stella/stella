import type { ToolSet } from "ai";

import type { ChatMessage } from "@/api/handlers/chat/types";

/**
 * Test-only adapter for `ToolSet` from the ai SDK.
 *
 * `ToolSet` is parameterised on the per-tool input/output schemas,
 * which is overkill for test fixtures that only need to exercise the
 * `execute()` hook. Tests build a plain record of fake tools and pass
 * the record through this helper so the cast lives in one place with
 * a single SAFETY comment instead of being repeated at every call.
 */
export const asTestToolSet = (tools: Record<string, unknown>): ToolSet =>
  // SAFETY: tests construct tool maps with only the fields read by the
  // helper under test (execute, inputSchema). The cast widens an
  // unconstrained record to the ai-sdk ToolSet shape.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  tools as unknown as ToolSet;

/**
 * Narrow a prepared tool slot to the minimal shape that tests exercise:
 * an optional `execute` callable. The prepared output is produced by
 * helpers like `prepareToolsForThirdParty`, which preserve the runtime
 * shape but cannot reconstruct the ai-sdk's parametric `Tool` type
 * after wrapping. Tests read back `prepared["name"]` via this helper.
 */
export type TestExecutable<TInput, TOutput> = {
  execute?: ((input: TInput) => Promise<TOutput>) | undefined;
};

export const asTestExecutable = <TInput, TOutput>(
  slot: unknown,
): TestExecutable<TInput, TOutput> | undefined =>
  // SAFETY: callers structurally narrow to the optional execute
  // callable shape, which matches the AI SDK Tool contract for the
  // fields under test.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  slot as TestExecutable<TInput, TOutput> | undefined;

/**
 * Read a JSON body from a test Response into a caller-declared shape.
 *
 * `Response.json()` is typed `Promise<unknown>` to force tests to
 * acknowledge the parsing boundary. Asserts on error envelopes,
 * status codes, etc. don't need full schema validation, so this
 * helper centralises the boundary cast.
 */
export const readTestJson = async <T>(resp: Response): Promise<T> =>
  // SAFETY: callers spell out the expected shape per-test; the
  // assertions immediately after the parse fail loudly if the body
  // doesn't match.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  (await resp.json()) as T;

/**
 * Build a `ChatMessage["parts"][number]` fixture from a literal object.
 *
 * The persisted UI message-parts union is a discriminated union over
 * ~12 variants (text, file, tool, dynamic-tool, ...); building one in
 * a test fixture from a literal misses the discriminator narrowing
 * unless the literal exactly matches one variant's shape. This helper
 * absorbs the resulting cast in one place so tests can express the
 * fixture inline.
 */
export const asChatPart = (part: object): ChatMessage["parts"][number] =>
  // SAFETY: each call site spells out the variant's discriminator
  // (type, state) explicitly; the helper widens that literal back to
  // the canonical persisted-part union.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  part as unknown as ChatMessage["parts"][number];
