import { panic } from "better-result";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import {
  getSyntheticSessionStatus,
  revokeSyntheticSessions,
} from "@/api/lib/synthetic-principal/store";

await runScriptWithErrorOutput(async () => {
  const command = process.argv.at(2);
  switch (command) {
    case "revoke":
      console.log(JSON.stringify(await revokeSyntheticSessions()));
      return;
    case "status":
      console.log(JSON.stringify(await getSyntheticSessionStatus()));
      return;
    default:
      panic("Usage: synthetic-session.ts revoke|status");
  }
});
