/**
 * Seed 2 real decisions from each Czech court type.
 *
 * Courts:
 *   NS  — Nejvyšší soud (rozhodnuti.nsoud.cz)
 *   NSS — Nejvyšší správní soud (vyhledavac.nssoud.cz)
 *   ÚS  — Ústavní soud (nalus.usoud.cz)
 *   Regional — Krajské soudy (rozhodnuti.justice.cz)
 *
 * Usage: bun run scripts/seed-all-courts.ts
 */

import { parseNsDecisionHtml } from "../apps/api/src/handlers/case-law/ingestion/parsers/cz-ns";
import { parseNssDecisionHtml } from "../apps/api/src/handlers/case-law/ingestion/parsers/cz-nss";
import { parseUsDecisionHtml } from "../apps/api/src/handlers/case-law/ingestion/parsers/cz-us";
import { parseRegionalDecision } from "../apps/api/src/handlers/case-law/ingestion/parsers/cz-regional";

const db = new Bun.SQL({
  hostname: "localhost",
  port: 5432,
  database: "stella",
  username: "postgres",
  password: "postgres",
});

const generateId = (): string => crypto.randomUUID();

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

const stripHtml = (html: string): string =>
  html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const upsert = async (
  sourceId: string,
  caseNumber: string,
  court: string,
  ecli: string | null,
  decisionDate: string | null,
  decisionType: string | null,
  fulltext: string,
  sourceUrl: string,
  ast: unknown,
  metadata: Record<string, unknown> = {},
) => {
  const slug = slugify(caseNumber);
  const id = generateId();
  await db`
    INSERT INTO case_law_decisions (
      id, source_id, case_number, slug, ecli, court,
      country, language, decision_date, decision_type,
      fulltext, source_url
    ) VALUES (
      ${id}, ${sourceId}, ${caseNumber}, ${slug},
      ${ecli}, ${court}, 'CZE', 'cs',
      ${decisionDate}, ${decisionType},
      ${fulltext}, ${sourceUrl}
    )
    ON CONFLICT (source_id, case_number, language)
    DO UPDATE SET
      fulltext = EXCLUDED.fulltext,
      ecli = EXCLUDED.ecli,
      decision_date = EXCLUDED.decision_date,
      decision_type = EXCLUDED.decision_type
  `;
  const astStr = JSON.stringify(ast);
  const metaStr = JSON.stringify(metadata);
  await db.unsafe(
    `UPDATE case_law_decisions
     SET document_ast = $1::jsonb, metadata = $3::jsonb
     WHERE case_number = $2 AND language = 'cs'
       AND source_id = $4`,
    [astStr, caseNumber, metaStr, sourceId],
  );
};

// ── Ensure sources exist ───────────────────────────────────

const ensureSources = async () => {
  const sources = [
    ["seed_cz_ns", "cz-ns-seed", "Nejvyšší soud (seed)"],
    ["seed_cz_nss", "cz-nss-seed", "Nejvyšší správní soud (seed)"],
    ["seed_cz_us", "cz-us-seed", "Ústavní soud (seed)"],
    ["seed_cz_regional", "cz-regional-seed", "Krajské soudy (seed)"],
  ];
  for (const [id, key, name] of sources) {
    await db.unsafe(
      `INSERT INTO case_law_sources (id, adapter_key, name)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [id!, key!, name!],
    );
  }
};

// ── NS (Nejvyšší soud) ────────────────────────────────────

const BASE_NS = "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf";
const NS_UNIDS = [
  "00053131A0026262C125819F00262FF8", // 23 Nd 480/2024
  "CBD000CC5A2294DEC1257E46001ABDE7", // 3 Tdo 232/2015
];

const seedNs = async () => {
  let ok = 0;
  for (const unid of NS_UNIDS) {
    const webUrl = `${BASE_NS}/WebSearch/${unid}?openDocument`;
    const printUrl = `${BASE_NS}/WebPrint/${unid}?openDocument`;
    const [webHtml, printHtml] = await Promise.all([
      fetch(webUrl).then((r) => (r.ok ? r.text() : "")),
      fetch(printUrl).then((r) => (r.ok ? r.text() : "")),
    ]);
    if (!printHtml) {continue;}

    const parsed = parseNsDecisionHtml({
      documentId: unid,
      webUrl,
      printUrl,
      webHtml,
      printHtml,
    });
    const cn = parsed.metadata.caseNumber ?? `ns-${unid}`;
    await upsert(
      "seed_cz_ns",
      cn,
      parsed.metadata.court ?? "Nejvyšší soud",
      parsed.metadata.ecli,
      parsed.metadata.decisionDate,
      parsed.metadata.decisionType,
      parsed.fulltext,
      webUrl,
      parsed.documentAst,
    );
    console.log(`  NS: ${cn} ✓ (${parsed.documentAst.blocks.length} blocks)`);
    ok++;
    await Bun.sleep(300);
  }
  return ok;
};

// ── NSS (Nejvyšší správní soud) ────────────────────────────

const BASE_NSS = "https://vyhledavac.nssoud.cz";

const initNssSession = async () => {
  const resp = await fetch(BASE_NSS, { redirect: "follow" });
  const html = await resp.text();
  return resp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

const NSS_DOC_IDS = ["780658", "780541"];

const seedNss = async () => {
  const cookies = await initNssSession();
  let ok = 0;
  for (const docId of NSS_DOC_IDS) {
    const htmlResp = await fetch(`${BASE_NSS}/DokumentOriginal/Html/${docId}`, {
      headers: { Cookie: cookies },
    });
    if (!htmlResp.ok) {continue;}
    const html = await htmlResp.text();
    if (html.length < 200) {continue;}

    const titleMatch = html.match(/<title>\s*(.+?)\s*-\s*html\s*<\/title>/i);
    const cn = titleMatch?.[1]
      ?.replace(/\s+/g, " ")
      .replace(/\s*-\s*/, "-")
      .trim();
    if (!cn) {continue;}

    // Get ECLI from detail page
    let ecli: string | undefined;
    try {
      const detResp = await fetch(`${BASE_NSS}/DokumentDetail/Index/${docId}`, {
        headers: { Cookie: cookies },
      });
      if (detResp.ok) {
        const detHtml = await detResp.text();
        const m = detHtml.match(
          /id="ecli"[^>]*>[\s\S]*?class="det-textval[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
        );
        ecli = m?.[1] ? stripHtml(m[1]).trim() : undefined;
      }
    } catch {}

    const parsed = parseNssDecisionHtml({
      caseNumber: cn,
      ecli,
      court: "Nejvyšší správní soud",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: `${BASE_NSS}/DokumentDetail/Index/${docId}`,
      html,
      detailMetadata: {},
    });

    await upsert(
      "seed_cz_nss",
      cn,
      "Nejvyšší správní soud",
      ecli ?? null,
      null,
      null,
      parsed.fulltext,
      `${BASE_NSS}/DokumentDetail/Index/${docId}`,
      parsed.documentAst,
    );
    console.log(`  NSS: ${cn} ✓ (${parsed.documentAst.blocks.length} blocks)`);
    ok++;
    await Bun.sleep(300);
  }
  return ok;
};

// ── ÚS (Ústavní soud) ─────────────────────────────────────

const US_CASES = [
  { sz: "I-100-25_1", label: "I.ÚS 100/25" },
  { sz: "Pl-24-10_1", label: "Pl.ÚS 24/10" },
];

const seedUs = async () => {
  let ok = 0;
  for (const { sz, label } of US_CASES) {
    const url = `https://nalus.usoud.cz/Search/GetText.aspx?sz=${sz}`;
    const resp = await fetch(url);
    if (!resp.ok) {continue;}
    const html = await resp.text();
    if (html.length < 200) {continue;}

    try {
      const parsed = parseUsDecisionHtml({
        html,
        caseNumber: label,
        ecli: undefined,
        court: "Ústavní soud",
        decisionDate: undefined,
        decisionType: undefined,
      });

      await upsert(
        "seed_cz_us",
        parsed.documentAst.metadata.caseNumber ?? label,
        "Ústavní soud",
        parsed.documentAst.metadata.ecli,
        parsed.documentAst.metadata.decisionDate,
        parsed.documentAst.metadata.decisionType,
        parsed.fulltext,
        url,
        parsed.documentAst,
      );
      const cn = parsed.documentAst.metadata.caseNumber ?? label;
      console.log(`  ÚS: ${cn} ✓ (${parsed.documentAst.blocks.length} blocks)`);
      ok++;
    } catch (error) {
      console.warn(`  ÚS: ${label} FAILED: ${error}`);
    }
    await Bun.sleep(300);
  }
  return ok;
};

// ── Regional Courts ────────────────────────────────────────

const BASE_REGIONAL = "https://rozhodnuti.justice.cz/api";

const seedRegional = async () => {
  // Find 2 decisions from today/recent
  const items: { uuid: string; jednaciCislo: string; ecli: string; soud: string; datumVydani: string; odkaz: string }[] = [];

  for (let daysAgo = 5; daysAgo < 30 && items.length < 2; daysAgo++) {
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    const url = `${BASE_REGIONAL}/opendata/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}?page=0`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {continue;}
      const data = await resp.json() as { items: typeof items };
      if (data.items?.length > 0) {
        items.push(...data.items.slice(0, 2 - items.length));
      }
    } catch {}
  }

  let ok = 0;
  for (const item of items) {
    const uuid = item.odkaz?.replace(/.*\/finaldoc\//, "") ?? item.uuid;
    if (!uuid) {continue;}

    try {
      const resp = await fetch(`${BASE_REGIONAL}/finaldoc/${uuid}`);
      if (!resp.ok) {continue;}
      const doc = await resp.json() as {
        header: unknown[];
        verdict: unknown[];
        justification: unknown[];
        information: unknown[];
        verdictText: string;
        justificationText: string;
        styles: unknown[];
        metadata: Record<string, unknown>;
      };

      const parsed = parseRegionalDecision({
        caseNumber: item.jednaciCislo,
        ecli: item.ecli,
        court: item.soud,
        decisionDate: item.datumVydani,
        decisionType: (doc.metadata?.type as string)?.toLowerCase(),
        sourceUrl: item.odkaz,
        header: doc.header as any[],
        verdict: doc.verdict as any[],
        justification: doc.justification as any[],
        information: doc.information as any[],
        styles: doc.styles as any[],
        verdictText: doc.verdictText ?? "",
        justificationText: doc.justificationText ?? "",
      });

      await upsert(
        "seed_cz_regional",
        item.jednaciCislo,
        item.soud,
        item.ecli,
        item.datumVydani,
        (doc.metadata?.type as string)?.toLowerCase() ?? null,
        parsed.fulltext,
        item.odkaz,
        parsed.documentAst,
        doc.metadata as Record<string, unknown>,
      );
      console.log(`  Regional: ${item.jednaciCislo} (${item.soud}) ✓ (${parsed.documentAst.blocks.length} blocks)`);
      ok++;
    } catch (error) {
      console.warn(`  Regional: ${item.jednaciCislo} FAILED: ${error}`);
    }
    await Bun.sleep(200);
  }
  return ok;
};

// ── Main ───────────────────────────────────────────────────

const main = async () => {
  await ensureSources();

  console.log("Seeding NS...");
  const ns = await seedNs();
  console.log("Seeding NSS...");
  const nss = await seedNss();
  console.log("Seeding ÚS...");
  const us = await seedUs();
  console.log("Seeding Regional...");
  const regional = await seedRegional();

  console.log(`\nDone: NS=${ns}, NSS=${nss}, ÚS=${us}, Regional=${regional}`);
  process.exit(0);
};

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
