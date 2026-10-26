import { panic } from "better-result";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { bindOwnerSyntheticSessionStore } from "@/api/db/root";
import { createSyntheticSessionStore } from "@/api/lib/synthetic-principal/store";

const store = bindOwnerSyntheticSessionStore(createSyntheticSessionStore);

await runScriptWithErrorOutput(async () => {
  const command = process.argv.at(2);
  if (command !== "revoke" && command !== "status") {
    panic("Usage: synthetic-session.ts revoke|status");
  }
  switch (command) {
    case "revoke":
      console.log(JSON.stringify(await store.revokeSyntheticSessions()));
      return;
    case "status":
      console.log(JSON.stringify(await store.getSyntheticSessionStatus()));
      return;
  }
});
