import { GENERATORS } from "./generated-files";

const LINTABLE_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const GENERATED_OUTPUTS = GENERATORS.flatMap(
  (generator) => generator.outputs,
).map((pattern) => new Bun.Glob(pattern));

export const isChangedLintPath = (file: string): boolean =>
  LINTABLE_SOURCE.test(file) &&
  !file.includes("/node_modules/") &&
  !GENERATED_OUTPUTS.some((glob) => glob.match(file));
