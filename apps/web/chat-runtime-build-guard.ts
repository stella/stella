import { panic } from "better-result";
import type { Plugin, Rolldown } from "vite";

type ChatRuntimeChunk = Pick<
  Rolldown.OutputChunk,
  "fileName" | "isEntry" | "imports" | "modules"
>;

export const assertLazyChatRuntime = (chunks: Iterable<ChatRuntimeChunk>) => {
  const byName = new Map([...chunks].map((chunk) => [chunk.fileName, chunk]));
  const pending = [...byName.values()].filter((chunk) => chunk.isEntry);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const chunk =
      pending.pop() ??
      panic("The eager chunk traversal lost its pending chunk");
    if (visited.has(chunk.fileName)) {
      continue;
    }
    visited.add(chunk.fileName);
    for (const id of Object.keys(chunk.modules)) {
      if (
        /[/\\]node_modules[/\\]@tanstack[/\\]ai(?:-client|-react)?[/\\]/u.test(
          id,
        )
      ) {
        panic(
          `Eager client chunk ${chunk.fileName} contains the chat AI runtime: ${id}`,
        );
      }
    }
    for (const name of chunk.imports) {
      const dependency = byName.get(name);
      if (dependency !== undefined) {
        pending.push(dependency);
      }
    }
  }
};

// Follow static imports, including named vendor chunks. Changing chunk names or
// splitting a vendor cannot hide an AI runtime paid on every cold navigation.
export const chatRuntimeBuildGuard = (): Plugin => ({
  name: "stella-chat-runtime-build-guard",
  apply: "build",
  applyToEnvironment: (environment) => environment.name === "client",
  generateBundle(_options, bundle) {
    assertLazyChatRuntime(
      Object.values(bundle).filter((output) => output.type === "chunk"),
    );
  },
});
