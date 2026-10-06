import { panic } from "better-result";

// setup-env resets developer URLs first; only this later engine-test preload
// can replace them with the isolated runner's dynamically published endpoint.
const endpoint = process.env["STELLA_CORPUS_ENGINE_TEST_ENDPOINT"];
if (
  process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] !== "true" ||
  endpoint === undefined
) {
  panic("Corpus engine preload requires the isolated suite runner");
}
const url = new URL(endpoint);
if (
  url.protocol !== "http:" ||
  url.hostname !== "127.0.0.1" ||
  url.port === "" ||
  url.username !== "" ||
  url.password !== "" ||
  url.pathname !== "/" ||
  url.search !== "" ||
  url.hash !== ""
) {
  panic(
    "Corpus engine test endpoint must be a loopback origin with an explicit port",
  );
}
process.env["CORPUS_INDEX_Q09_ENDPOINT"] = url.origin;
process.env["CORPUS_INDEX_Q09_SEARCH_ENDPOINT"] = url.origin;
