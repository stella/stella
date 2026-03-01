/**
 * Missing type aliases in @litko/yara-x.
 * The package's auto-generated .d.ts references YaraXImpl and
 * CompilerOptionsType but never declares them.
 */
import "@litko/yara-x";

declare module "@litko/yara-x" {
  type YaraXImpl = YaraX;
  type CompilerOptionsType = CompilerOptions;
}
