const LINTABLE_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const GENERATED_OR_EXTERNAL =
  /(?:\.gen\.(?:[cm]?[jt]s|[jt]sx)$|\/generated\/|\/node_modules\/|routeTree\.gen)/u;

export const isChangedLintPath = (file: string): boolean =>
  LINTABLE_SOURCE.test(file) && !GENERATED_OR_EXTERNAL.test(file);
