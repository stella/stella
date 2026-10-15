import { requestHandler } from "@tanstack/react-start/server";
import { test } from "bun:test";

// Bun executes server branches of the web modules. Scope each browser-model
// scenario to a real request so API headers never read missing framework state.
export const requestTest = (name: string, scenario: () => unknown) =>
  test(name, async () => {
    const handle = requestHandler(async () => {
      await scenario();
      return new Response(null);
    });
    await handle(new Request("http://localhost:3000/"), {});
  });
