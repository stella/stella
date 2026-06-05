/**
 * Nightly validation: every model ID stella offers must still exist —
 * and not be deprecated — upstream.
 *
 * Providers retire and rename models on their own schedules. When a
 * model in `@stll/ai-catalog` is shut down, a user's request 400s at
 * runtime and nobody finds out until they complain. This check turns
 * that silent failure into a loud CI failure, using live, public,
 * keyless listings.
 *
 * Two signals, strongest first:
 *  1. Deprecation — models.dev publishes first-party provider catalogs
 *     (google/openai/anthropic/mistral) keyed by the provider-native ID
 *     with a `status: "deprecated"` marker. A deprecated model still
 *     answers for now but is on its way out; flagging it gives us lead
 *     time to migrate before the hard shutdown. (This is exactly the
 *     `gemini-3.1-flash-lite-preview` case: still listed everywhere,
 *     but marked deprecated.)
 *  2. Existence — IDs not carried as a first-party models.dev key
 *     (OpenRouter slugs, vendor-dated aliases) are checked for mere
 *     presence against OpenRouter's API and the full models.dev set.
 *
 * Aggregators lag on brand-new models, and a model we offer may be
 * deprecated upstream while we still intend to serve it until shutdown.
 * Either case is parked in ACKNOWLEDGED (with a dated note) so the
 * check stays green until the real removal — which it then catches.
 *
 * Usage: bun packages/scripts/src/model-catalog-upstream.ts
 */
import { BYOK_MODEL_OPTIONS, DEFAULT_MODELS } from "@stll/ai-catalog";

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Known exceptions the check should not fail on, keyed by `canonical()`
 * form. Use for: (a) a model offered ahead of aggregator indexing, or
 * (b) a model deprecated upstream that we deliberately keep serving
 * until its shutdown date. Always leave a dated note; never park an ID
 * to hide a real removal.
 */
// Seed with canonical() forms, e.g.
//   ACKNOWLEDGED.add("gpt56nano"); // added 2026-06-05, not yet indexed
const ACKNOWLEDGED = new Set<string>();

/**
 * Catalog providers whose IDs map 1:1 to a models.dev first-party
 * catalog (same key, same native ID), so we can read its authoritative
 * `status` field. The values are also the models.dev provider keys.
 */
const MODELS_DEV_PROVIDER: Record<string, string> = {
  google: "google",
  openai: "openai",
  anthropic: "anthropic",
  mistral: "mistral",
};
const FIRST_PARTY_KEYS = new Set(Object.values(MODELS_DEV_PROVIDER));

/** IDs are customer deployment names or server-resolved alias tags; */
/** not checkable against a public model list. */
const CUSTOM_ID_PROVIDERS = new Set(["azure_foundry", "huggingface"]);
const isAliasTag = (modelId: string): boolean => modelId.endsWith("-latest");

/** Punctuation/case-insensitive form so `claude-opus-4-8`, */
/** `claude-opus-4.8`, and `anthropic/claude-opus-4.8` all match. */
const canonical = (modelId: string): string => {
  const slug = modelId.includes("/")
    ? (modelId.split("/").at(-1) ?? modelId)
    : modelId;
  return slug.toLowerCase().replace(/[.\-_]/gu, "");
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

type CatalogEntry = { provider: string; modelId: string };

const collectCatalogEntries = (): CatalogEntry[] => {
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();

  const add = (provider: string, modelId: string) => {
    if (CUSTOM_ID_PROVIDERS.has(provider) || provider === "openai_compatible") {
      return;
    }
    if (isAliasTag(modelId)) {
      return;
    }
    const key = `${provider}::${modelId}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({ provider, modelId });
  };

  for (const [provider, models] of Object.entries(BYOK_MODEL_OPTIONS)) {
    for (const modelId of models) {
      add(provider, modelId);
    }
  }
  for (const [provider, roles] of Object.entries(DEFAULT_MODELS)) {
    for (const modelId of Object.values(roles)) {
      add(provider, modelId);
    }
  }

  return entries;
};

const asMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type FetchResult = { ok: true; body: unknown } | { ok: false; reason: string };

const fetchJson = async (url: string): Promise<FetchResult> => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { ok: false, reason: `responded ${response.status}` };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, reason: asMessage(error) };
  }
};

type Upstream = {
  /** Exact OpenRouter slugs, lowercased. */
  openrouterSlugs: Set<string>;
  /** canonical() of every id seen anywhere (existence fallback). */
  canonAll: Set<string>;
  /** `${provider}:${nativeId}` present in a first-party models.dev catalog. */
  firstPartyPresent: Set<string>;
  /** `${provider}:${nativeId}` marked `status: "deprecated"` upstream. */
  firstPartyDeprecated: Set<string>;
  /** Whether any source was reachable at all. */
  reachable: boolean;
};

const loadUpstream = async (): Promise<Upstream> => {
  const openrouterSlugs = new Set<string>();
  const canonAll = new Set<string>();
  const firstPartyPresent = new Set<string>();
  const firstPartyDeprecated = new Set<string>();
  let reachable = false;

  const openrouter = await fetchJson("https://openrouter.ai/api/v1/models");
  if (openrouter.ok) {
    reachable = true;
    const rawData = isObject(openrouter.body)
      ? openrouter.body["data"]
      : undefined;
    const data = isUnknownArray(rawData) ? rawData : [];
    for (const item of data) {
      if (isObject(item) && typeof item["id"] === "string") {
        openrouterSlugs.add(item["id"].toLowerCase());
        canonAll.add(canonical(item["id"]));
      }
    }
    console.log(`  OpenRouter: ${openrouterSlugs.size} models`);
  } else {
    console.warn(`  OpenRouter: unreachable (${openrouter.reason})`);
  }

  const modelsDev = await fetchJson("https://models.dev/api.json");
  if (modelsDev.ok && isObject(modelsDev.body)) {
    reachable = true;
    let count = 0;
    for (const [providerKey, providerVal] of Object.entries(modelsDev.body)) {
      if (!isObject(providerVal) || !isObject(providerVal["models"])) {
        continue;
      }
      const isFirstParty = FIRST_PARTY_KEYS.has(providerKey);
      for (const [modelId, modelVal] of Object.entries(providerVal["models"])) {
        canonAll.add(canonical(modelId));
        count += 1;
        if (!isFirstParty) {
          continue;
        }
        const key = `${providerKey}:${modelId}`;
        firstPartyPresent.add(key);
        if (isObject(modelVal) && modelVal["status"] === "deprecated") {
          firstPartyDeprecated.add(key);
        }
      }
    }
    console.log(`  models.dev: ${count} models`);
  } else if (!modelsDev.ok) {
    console.warn(`  models.dev: unreachable (${modelsDev.reason})`);
  }

  return {
    openrouterSlugs,
    canonAll,
    firstPartyPresent,
    firstPartyDeprecated,
    reachable,
  };
};

type Verdict =
  | { kind: "ok" }
  | { kind: "deprecated"; detail: string }
  | { kind: "missing"; detail: string };

const classify = (entry: CatalogEntry, upstream: Upstream): Verdict => {
  const { provider, modelId } = entry;

  // OpenRouter slugs: OpenRouter's own API is authoritative for what it
  // still routes (it drops dead routes). Exact match, canonical fallback.
  if (provider === "openrouter") {
    if (
      upstream.openrouterSlugs.has(modelId.toLowerCase()) ||
      upstream.canonAll.has(canonical(modelId))
    ) {
      return { kind: "ok" };
    }
    return { kind: "missing", detail: "not routed by OpenRouter" };
  }

  // Native providers with a first-party models.dev catalog: read the
  // authoritative `status` field.
  const mdProvider = MODELS_DEV_PROVIDER[provider];
  if (mdProvider !== undefined) {
    const key = `${mdProvider}:${modelId}`;
    if (upstream.firstPartyDeprecated.has(key)) {
      return { kind: "deprecated", detail: "models.dev status=deprecated" };
    }
    if (upstream.firstPartyPresent.has(key)) {
      return { kind: "ok" };
    }
  }

  // Not a first-party key (vendor-dated alias like mistral-medium-3-5,
  // or models.dev simply doesn't carry it): fall back to existence.
  if (upstream.canonAll.has(canonical(modelId))) {
    return { kind: "ok" };
  }
  return { kind: "missing", detail: "absent from every upstream listing" };
};

const main = async (): Promise<void> => {
  console.log("Validating offered model IDs against upstream listings…");
  const upstream = await loadUpstream();

  if (!upstream.reachable) {
    // Every source down: a network problem, not a model removal. Don't
    // cry wolf — pass with a warning.
    console.warn(
      "\n⚠ No upstream source reachable; skipping validation this run.",
    );
    return;
  }

  const entries = collectCatalogEntries();
  const failures: { entry: CatalogEntry; verdict: Verdict }[] = [];

  for (const entry of entries) {
    const verdict = classify(entry, upstream);
    if (verdict.kind === "ok") {
      continue;
    }
    // ACKNOWLEDGED is intentionally empty by default — it's the
    // seam maintainers fill to park a known new/deprecated model, so an
    // empty default is correct, not dead code.
    // eslint-disable-next-line sonarjs/no-empty-collection
    if (ACKNOWLEDGED.has(canonical(entry.modelId))) {
      console.log(
        `  · acknowledged ${verdict.kind} ${entry.provider} / ${entry.modelId}`,
      );
      continue;
    }
    failures.push({ entry, verdict });
  }

  console.log(`\nChecked ${entries.length} offered model IDs.`);

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} offered model ID(s) need attention:`);
    for (const { entry, verdict } of failures) {
      const label = verdict.kind === "deprecated" ? "DEPRECATED" : "MISSING";
      const detail = "detail" in verdict ? ` — ${verdict.detail}` : "";
      console.error(
        `  ✗ [${label}] ${entry.provider} / ${entry.modelId}${detail}`,
      );
    }
    console.error(
      "\nResolve by updating @stll/ai-catalog (migrate off the model), or,\n" +
        "if the model is real and we deliberately keep serving it, add its\n" +
        "canonical() form to ACKNOWLEDGED in this script with a dated note.",
    );
    process.exit(1);
  }

  console.log("\n✓ All offered model IDs are present and current upstream.");
};

await main();
