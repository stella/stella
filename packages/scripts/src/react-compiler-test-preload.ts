// Test preload: Bun loads every source module through the React Compiler, as
// the app's Vite build does, so a test renders the program that ships. Test
// files themselves load as written (see `reactCompilerBunPlugin`).
import { reactCompilerBunPlugin } from "./react-compiler-bun-plugin";

Bun.plugin(reactCompilerBunPlugin);
