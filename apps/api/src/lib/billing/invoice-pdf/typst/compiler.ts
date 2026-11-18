import initCompiler, {
  type InitOutput,
  type TypstCompiler,
  TypstCompilerBuilder,
} from "@myriaddreamin/typst-ts-web-compiler";

import dejaVuPath from "@/api/lib/files/pdf-signing/fonts/DejaVuSans.ttf" with { type: "file" };

import interBoldPath from "./fonts/Inter-Bold.ttf" with { type: "file" };
import interRegularPath from "./fonts/Inter-Regular.ttf" with { type: "file" };
import interSemiBoldPath from "./fonts/Inter-SemiBold.ttf" with { type: "file" };

/**
 * The only fonts a template can use. Inter covers Latin with full Central
 * European diacritics and tabular figures; DejaVu Sans is the fallback for
 * scripts Inter lacks. Nothing is read from the host.
 */
export const TYPST_FONT_PATHS = [
  interRegularPath,
  interSemiBoldPath,
  interBoldPath,
  dejaVuPath,
] as const;

export type TypstOutputFormat = "pdf" | "vector";

type TypstCompileOutcome =
  | { status: "ok"; bytes: Uint8Array }
  | { status: "error"; diagnostics: string[] };

/** Typst's structured diagnostics: returned, never thrown. */
const DIAGNOSTICS_FULL = 2;
const MAIN_PATH = "/main.typ";

type TypstWasmCompiler = {
  compile: (input: {
    template: string;
    inputs: Record<string, string>;
    format: TypstOutputFormat;
  }) => TypstCompileOutcome;
  /** Current size of the compiler's linear memory; it never shrinks. */
  memoryBytes: () => number;
};

let initialized: Promise<InitOutput> | null = null;

const initialize = async () => {
  initialized ??= Bun.file(
    new URL(import.meta.resolve("@myriaddreamin/typst-ts-web-compiler/wasm")),
  )
    .arrayBuffer()
    .then(async (bytes) => initCompiler({ module_or_path: bytes }));
  return initialized;
};

const isDiagnosticList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Builds the WASM Typst compiler with no file system: the access model is the
 * dummy one, so `read`, `image`, `json`, `plugin` and package imports of any
 * path other than the in-memory main file fail with "access denied". Data
 * reaches the template only through `sys.inputs`.
 */
export const createTypstWasmCompiler = async (): Promise<TypstWasmCompiler> => {
  const wasm = await initialize();
  const builder = new TypstCompilerBuilder();
  builder.set_dummy_access_model();
  for (const path of TYPST_FONT_PATHS) {
    await builder.add_raw_font(
      new Uint8Array(await Bun.file(path).arrayBuffer()),
    );
  }
  const compiler: TypstCompiler = await builder.build();
  return {
    compile: ({ template, inputs, format }) => {
      compiler.reset_shadow();
      compiler.add_source(MAIN_PATH, template);
      const result: unknown = compiler.compile(
        MAIN_PATH,
        Object.entries(inputs),
        format,
        DIAGNOSTICS_FULL,
      );
      if (typeof result === "object" && result !== null) {
        if ("result" in result && result.result instanceof Uint8Array) {
          return { status: "ok", bytes: result.result };
        }
        if ("diagnostics" in result && isDiagnosticList(result.diagnostics)) {
          return { status: "error", diagnostics: result.diagnostics };
        }
      }
      return {
        status: "error",
        diagnostics: ["Typst returned neither a document nor diagnostics"],
      };
    },
    memoryBytes: () => wasm.memory.buffer.byteLength,
  };
};
