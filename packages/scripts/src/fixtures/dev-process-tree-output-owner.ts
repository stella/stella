import { panic } from "better-result";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { json } from "node:stream/consumers";
import * as v from "valibot";

import { spawnDevProcess } from "../dev-process-groups";

const readySchema = v.object({ pid: v.number(), port: v.number() });
const [rootDir, resultPath, termMode] = process.argv.slice(2);
if (!rootDir || !resultPath || (termMode !== "exit" && termMode !== "ignore")) {
  panic("Expected root directory, result path, and termination mode");
}

const readyPath = path.join(rootDir, "output-ready.sock");
const server = createServer();
const {
  promise: ready,
  resolve: resolveReady,
  reject: rejectReady,
} = Promise.withResolvers<v.InferOutput<typeof readySchema>>();
server.once("error", rejectReady);
server.on("connection", (socket) => {
  json(socket)
    .then((value) => v.parse(readySchema, value))
    .then(resolveReady)
    .catch(rejectReady);
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(readyPath, resolve);
});

const child = spawnDevProcess({
  rootDir,
  cmd: [
    process.execPath,
    new URL("dev-process-tree.ts", import.meta.url).pathname,
    "leader",
    readyPath,
    termMode,
  ],
  cwd: rootDir,
  env: process.env,
  label: `output fixture ${termMode}`,
  output: "ignore",
  stdin: "ignore",
}).unwrap("The output fixture tree must start");
const tree = await ready;
server.close();
child.kill("SIGTERM");
await child.exited;
writeFileSync(resultPath, JSON.stringify({ pgid: child.pid, ...tree }));
