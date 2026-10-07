import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects a leaked proven stream reader", async () => {
  expect(
    await lintSingleRule(
      "require-stream-reader-disposal",
      `async function consume(stream:ReadableStream) {
const reader=stream.getReader();
await reader.read();
}`,
    ),
  ).toEqual([2]);
});

test("requires cancellation before release after a partial read", async () => {
  expect(
    await lintSingleRule(
      "require-stream-reader-disposal",
      `async function consume(stream:ReadableStream) {
const reader=stream.getReader();
try {await reader.read();} finally {reader.releaseLock();}
}`,
    ),
  ).toEqual([2]);
});

test("allows aliased cleanup that survives cancellation rejection", async () => {
  expect(
    await lintSingleRule(
      "require-stream-reader-disposal",
      `async function consume(stream:ReadableStream) {
const reader=stream.getReader(); const owned=reader;
try {await owned.read();} finally {await owned.cancel().catch(()=>undefined); owned.releaseLock();}
}`,
    ),
  ).toEqual([]);
});

test("allows ownership transfer and ignores lookalike readers", async () => {
  expect(
    await lintSingleRule(
      "require-stream-reader-disposal",
      `function transfer(stream:ReadableStream) {return stream.getReader();}
async function consume(source:{getReader:()=>{read:()=>Promise<string>}}) {const reader=source.getReader();return await reader.read();}`,
    ),
  ).toEqual([]);
});

test("allows natural EOF completion followed by unconditional lock release", async () => {
  expect(
    await lintSingleRule(
      "require-stream-reader-disposal",
      `async function consume(stream:ReadableStream) {
const reader=stream.getReader();
try {while(true) {const result=await reader.read(); if(result.done) break;}}
finally {reader.releaseLock();}
}`,
    ),
  ).toEqual([]);
});
test("rejects cleanup that covers only one exit branch", async () => {
  expect(
    await lintSingleRule(
      "require-stream-reader-disposal",
      `async function consume(stream:ReadableStream,cleanup:boolean) {
const reader=stream.getReader();
try {await reader.read();}
finally {if(cleanup) {await reader.cancel().catch(()=>undefined); reader.releaseLock();}}
}`,
    ),
  ).toEqual([2]);
});

test("requires lock release to survive cancellation rejection", async () => {
  expect(
    await lintSingleRule(
      "require-stream-reader-disposal",
      `async function consume(stream:ReadableStream) {
const reader=stream.getReader();
try {await reader.read();}
finally {await reader.cancel(); reader.releaseLock();}
}`,
    ),
  ).toEqual([2]);
});
