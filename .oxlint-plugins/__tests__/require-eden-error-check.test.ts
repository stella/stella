import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects rejection-only handling and discarded awaits", async () => {
  expect(
    await lintSingleRule(
      "require-eden-error-check",
      `import {api} from "@/lib/api";
api.tasks.get().catch(capture);
async function load(){await api.tasks.get();}`,
    ),
  ).toEqual([2, 3]);
});

test("rejects data consumption before a later error read", async () => {
  expect(
    await lintSingleRule(
      "require-eden-error-check",
      `import {api as client} from "@/lib/api";
async function load(){
const response=await client.tasks.get();
consume(response.data);
return response.error;
}`,
    ),
  ).toEqual([3]);
});

test("allows error inspection before data and the canonical adapter", async () => {
  expect(
    await lintSingleRule(
      "require-eden-error-check",
      `import {api} from "@/lib/api";
import {unwrapEden as unwrap} from "@/lib/errors/api";
async function load(){const response=await api.tasks.get(); if(response.error) return response.error; return response.data;}
async function adapted(){return unwrap(await api.tasks.get());}`,
    ),
  ).toEqual([]);
});

test("ignores unrelated clients and lexical shadows", async () => {
  expect(
    await lintSingleRule(
      "require-eden-error-check",
      `import {api} from "@/lib/api";
function load(api:any){api.tasks.get().catch(capture);}
other.tasks.get().then(consume);`,
    ),
  ).toEqual([]);
});

test("requires error inspection on every branch before data consumption", async () => {
  expect(
    await lintSingleRule(
      "require-eden-error-check",
      `import {api} from "@/lib/api";
async function load(condition:boolean) {
const response=await api.tasks.get();
if(condition) {consume(response.error);}
return response.data;
}`,
    ),
  ).toEqual([3]);
});
test("allows all branches to inspect errors before joining data consumption", async () => {
  expect(
    await lintSingleRule(
      "require-eden-error-check",
      `import {api} from "@/lib/api";
async function load(condition:boolean) {
const response=await api.tasks.get();
if(condition) {consume(response.error);} else {capture(response.error);}
return response.data;
}`,
    ),
  ).toEqual([]);
});

test("rejects then callbacks that consume data without the error channel", async () => {
  expect(
    await lintSingleRule(
      "require-eden-error-check",
      `import {api} from "@/lib/api";
api.tasks.get().then(response=>consume(response.data));`,
    ),
  ).toEqual([2]);
});
