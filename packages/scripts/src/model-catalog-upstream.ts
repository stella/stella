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
 * Two signals:
 *  1. Deprecation — models.dev publishes first-party provider catalogs
 *     (google/openai/anthropic/mistral) keyed by the provider-native ID
 *     with a `status: "deprecated"` marker. A deprecated model still
 *     answers for now but is on its way out; flagging it gives us lead
 *     time to migrate before the hard shutdown. (This is exactly the
 *     `gemini-3.1-flash-lite-preview` case: still listed everywhere,
 *     but marked deprecated.)
 *  2. Existence — OpenRouter slugs are checked for presence against
 *     OpenRouter's routing API; future non-first-party providers can
 *     fall back to the full upstream model set.
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
 * Known exceptions the check should not fail on, keyed by provider and
 * canonical model form. Use for: (a) a model offered ahead of
 * aggregator indexing, or (b) a model deprecated upstream that we
 * deliberately keep serving until its shutdown date. Always leave a
 * dated note; never park an ID to hide a real removal.
 */
type AcknowledgementKey = `${string}:${string}`;

// Seed with acknowledgementKey() forms, e.g.
//   ACKNOWLEDGED.add("openai:gpt56nano"); // added 2026-06-05, not yet indexed
const ACKNOWLEDGED = new Set<AcknowledgementKey>();

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

/** IDs are customer deployment names; */
/** not checkable against a public model list. */
const CUSTOM_ID_PROVIDERS = new Set(["azure_foundry", "huggingface"]);

/** Punctuation/case-insensitive form so `claude-opus-4-8`, */
/** `claude-opus-4.8`, and `anthropic/claude-opus-4.8` all match. */
const canonical = (modelId: string): string => {
  const slug = modelId.includes("/")
    ? (modelId.split("/").at(-1) ?? modelId)
    : modelId;
  return slug.toLowerCase().replace(/[.\-_]/gu, "");
};

/** OpenRouter route form, keeping the provider prefix significant. */
const canonicalOpenRouterId = (modelId: string): string =>
  modelId.toLowerCase().replace(/[.\-_]/gu, "");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

type CatalogEntry = { provider: string; modelId: string };

const acknowledgementKey = ({
  provider,
  modelId,
}: CatalogEntry): AcknowledgementKey => {
  const id =
    provider === "openrouter"
      ? canonicalOpenRouterId(modelId)
      : canonical(modelId);
  return `${provider}:${id}`;
};

/**
 * Native provider aliases that models.dev does not expose as exact
 * catalog keys. Example: Mistral's docs use `mistral-medium-3-5`,
 * while models.dev currently indexes nearby dated Mistral keys. Keep
 * this provider-scoped, exact, and dated.
 */
const FIRST_PARTY_ALIAS_FALLBACK = new Set<AcknowledgementKey>([
  "mistral:mistralmedium35", // added 2026-06-05; Mistral Medium 3.5 API alias
]);

const collectCatalogEntries = (): CatalogEntry[] => {
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();

  const add = (provider: string, modelId: string) => {
    if (CUSTOM_ID_PROVIDERS.has(provider) || provider === "openai_compatible") {
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
  /** canonical() of OpenRouter slugs only. */
  openrouterCanon: Set<string>;
  /** canonical() of every id seen anywhere (existence fallback). */
  canonAll: Set<string>;
  /** `${provider}:${nativeId}` present in a first-party models.dev catalog. */
  firstPartyPresent: Set<string>;
  /** `${provider}:${nativeId}` marked `status: "deprecated"` upstream. */
  firstPartyDeprecated: Set<string>;
  /** OpenRouter listing was fetched and parsed. */
  openrouterReachable: boolean;
  /** models.dev listing was fetched and parsed. */
  modelsDevReachable: boolean;
};

const loadUpstream = async (): Promise<Upstream> => {
  const openrouterSlugs = new Set<string>();
  const openrouterCanon = new Set<string>();
  const canonAll = new Set<string>();
  const firstPartyPresent = new Set<string>();
  const firstPartyDeprecated = new Set<string>();
  let openrouterReachable = false;
  let modelsDevReachable = false;

  const openrouter = await fetchJson("https://openrouter.ai/api/v1/models");
  if (openrouter.ok) {
    openrouterReachable = true;
    const rawData = isObject(openrouter.body)
      ? openrouter.body["data"]
      : undefined;
    const data = isUnknownArray(rawData) ? rawData : [];
    for (const item of data) {
      if (isObject(item) && typeof item["id"] === "string") {
        const id = item["id"].toLowerCase();
        openrouterSlugs.add(id);
        openrouterCanon.add(canonicalOpenRouterId(id));
        canonAll.add(canonical(id));
      }
    }
    console.log(`  OpenRouter: ${openrouterSlugs.size} models`);
  } else {
    console.warn(`  OpenRouter: unreachable (${openrouter.reason})`);
  }

  const modelsDev = await fetchJson("https://models.dev/api.json");
  if (modelsDev.ok && isObject(modelsDev.body)) {
    modelsDevReachable = true;
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
    openrouterCanon,
    canonAll,
    firstPartyPresent,
    firstPartyDeprecated,
    openrouterReachable,
    modelsDevReachable,
  };
};

type Verdict =
  | { kind: "ok" }
  | { kind: "deprecated"; detail: string }
  | { kind: "missing"; detail: string }
  | { kind: "unverified"; detail: string };

const classify = (entry: CatalogEntry, upstream: Upstream): Verdict => {
  const { provider, modelId } = entry;

  // OpenRouter slugs: OpenRouter's own API is authoritative for what it
  // still routes (it drops dead routes). Exact match, canonical fallback.
  if (provider === "openrouter") {
    if (!upstream.openrouterReachable) {
      return { kind: "unverified", detail: "OpenRouter listing unreachable" };
    }
    if (
      upstream.openrouterSlugs.has(modelId.toLowerCase()) ||
      upstream.openrouterCanon.has(canonicalOpenRouterId(modelId))
    ) {
      return { kind: "ok" };
    }
    return { kind: "missing", detail: "not routed by OpenRouter" };
  }

  // Native providers with a first-party models.dev catalog: read the
  // authoritative `status` field.
  const mdProvider = MODELS_DEV_PROVIDER[provider];
  if (mdProvider !== undefined) {
    if (!upstream.modelsDevReachable) {
      return { kind: "unverified", detail: "models.dev listing unreachable" };
    }
    const key = `${mdProvider}:${modelId}`;
    if (upstream.firstPartyDeprecated.has(key)) {
      return { kind: "deprecated", detail: "models.dev status=deprecated" };
    }
    if (upstream.firstPartyPresent.has(key)) {
      return { kind: "ok" };
    }
    if (
      FIRST_PARTY_ALIAS_FALLBACK.has(acknowledgementKey(entry)) &&
      upstream.canonAll.has(canonical(modelId))
    ) {
      return { kind: "ok" };
    }
    return {
      kind: "missing",
      detail: "absent from models.dev first-party catalog",
    };
  }

  // Future non-first-party providers can fall back to existence in any
  // reachable upstream listing.
  if (upstream.canonAll.has(canonical(modelId))) {
    return { kind: "ok" };
  }
  return { kind: "missing", detail: "absent from every upstream listing" };
};

const main = async (): Promise<void> => {
  console.log("Validating offered model IDs against upstream listings…");
  const upstream = await loadUpstream();

  const entries = collectCatalogEntries();
  const failures: { entry: CatalogEntry; verdict: Verdict }[] = [];
  const unverified: { entry: CatalogEntry; verdict: Verdict }[] = [];

  for (const entry of entries) {
    const verdict = classify(entry, upstream);
    if (verdict.kind === "ok") {
      continue;
    }
    if (verdict.kind === "unverified") {
      unverified.push({ entry, verdict });
      continue;
    }
    // ACKNOWLEDGED is intentionally empty by default — it's the
    // set maintainers use to park a known new/deprecated model, so an
    // empty default is correct, not dead code.
    // eslint-disable-next-line sonarjs/no-empty-collection
    if (ACKNOWLEDGED.has(acknowledgementKey(entry))) {
      console.log(
        `  · acknowledged ${verdict.kind} ${entry.provider} / ${entry.modelId}`,
      );
      continue;
    }
    failures.push({ entry, verdict });
  }

  console.log(`\nChecked ${entries.length} offered model IDs.`);

  if (unverified.length > 0) {
    console.warn(
      `\n⚠ Skipped ${unverified.length} offered model ID(s) because an upstream source was unavailable:`,
    );
    for (const { entry, verdict } of unverified) {
      const detail = "detail" in verdict ? ` — ${verdict.detail}` : "";
      console.warn(
        `  ⚠ [UNVERIFIED] ${entry.provider} / ${entry.modelId}${detail}`,
      );
    }
  }

  if (entries.length > 0 && unverified.length === entries.length) {
    console.error(
      "\n✗ No offered model IDs were verified because every authoritative source was unavailable.",
    );
    process.exit(1);
  }

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
        "provider-scoped acknowledgementKey() form to ACKNOWLEDGED with a dated note.",
    );
    process.exit(1);
  }

  if (unverified.length > 0) {
    console.log(
      "\n✓ Verified all model IDs whose authoritative source was reachable.",
    );
    return;
  }

  console.log("\n✓ All offered model IDs are present and current upstream.");
};

await main();
