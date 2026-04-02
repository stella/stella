/**
 * Seed the local DB with NSS decisions by fetching rich HTML
 * from vyhledavac.nssoud.cz and parsing via cz-nss parser.
 *
 * Usage: bun run scripts/seed-nss-test.ts
 */

import { parseNssDecisionHtml } from "../apps/api/src/handlers/case-law/ingestion/parsers/cz-nss";

const db = new Bun.SQL({
  hostname: "localhost",
  port: 5432,
  database: "stella",
  username: "postgres",
  password: "postgres",
});

const BASE = "https://vyhledavac.nssoud.cz";

const generateId = (): string => crypto.randomUUID();

const slugify = (caseNumber: string): string =>
  caseNumber
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

const stripHtml = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const parseCeDate = (dateStr: string): string | undefined => {
  const match = dateStr.match(
    /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/,
  );
  if (!match) {return undefined;}
  const [, day, month, year] = match;
  return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
};

// ── Session management ─────────────────────────────────────

const initSession = async () => {
  const resp = await fetch(BASE, { redirect: "follow" });
  const html = await resp.text();
  const cookies = resp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const tokenMatch = html.match(
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/,
  );
  const token = tokenMatch?.[1];
  if (!token) {throw new Error("No antiforgery token");}

  const fields = new Map<string, string>();
  const hiddenRe =
    /<input\b(?=[^>]*\btype=["']hidden["'])(?=[^>]*\bname=["']([^"']*)["'])(?=[^>]*\bvalue=["']([^"']*)["'])[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = hiddenRe.exec(html)) !== null) {
    if (m[1] && m[2] !== undefined) {fields.set(m[1], m[2]);}
  }
  const textRe =
    /<input[^>]*\btype=["']text["'][^>]*\bname=["']([^"']*)["'][^>]*>/gi;
  while ((m = textRe.exec(html)) !== null) {
    if (m[1] && !fields.has(m[1])) {fields.set(m[1], "");}
  }

  return { cookies, token, fields };
};

// ── Main ───────────────────────────────────────────────────

const FROM_FIELD =
  "vyhledavaciSekce[1].vyhledavaciPodminka[0]" +
  ".vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd";
const TO_FIELD =
  "vyhledavaciSekce[1].vyhledavaciPodminka[0]" +
  ".vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo";

const main = async () => {
  // Ensure NSS source exists
  await db`
    INSERT INTO case_law_sources (id, adapter_key, name)
    VALUES ('test_cz_nss', 'cz-nss', 'Czech Supreme Administrative Court (test)')
    ON CONFLICT (adapter_key) DO NOTHING
  `;

  const session = await initSession();
  console.log("Session OK");

  // Known document IDs from vyhledavac.nssoud.cz
  const DOC_IDS = [
    "780658",
    "780541",
    "780548",
    "780647",
    "780284",
  ];

  let success = 0;

  for (const docId of DOC_IDS) {
      // Fetch rich HTML
      const htmlResp = await fetch(
        `${BASE}/DokumentOriginal/Html/${docId}`,
        { headers: { Cookie: session.cookies } },
      );

      if (!htmlResp.ok) {
        console.warn(`  ${docId}: HTML fetch failed`);
        continue;
      }

      const html = await htmlResp.text();
      if (
        html.length < 200 ||
        html.includes("<body>\n    N/A\n</body>")
      ) {
        console.warn(`  ${docId}: N/A (skipped)`);
        continue;
      }

      // Extract case number from HTML <title>
      // Format: "  2 As      3/2025-   50 - html"
      const titleMatch = html.match(
        /<title>\s*(.+?)\s*-\s*html\s*<\/title>/i,
      );
      const caseNumber = titleMatch?.[1]
        ?.replace(/\s+/g, " ")
        .replace(/\s*-\s*/, "-")
        .trim();
      if (!caseNumber) {
        console.warn(`  ${docId}: no case number in title`);
        continue;
      }

      // Fetch detail metadata (all available fields)
      const detail: Record<string, string | undefined> = {};
      try {
        const detResp = await fetch(
          `${BASE}/DokumentDetail/Index/${docId}`,
          { headers: { Cookie: session.cookies } },
        );
        if (detResp.ok) {
          const detHtml = await detResp.text();
          const divIds = [
            "ecli",
            "datumvydanirozhodnuti",
            "druhdokumentuavyrokrozhodnuti",
            "vyrokrozhodnuti",
            "soudcezpravodaj",
            "soudsenat",
            "oblastupravy",
            "typrizeni",
            "stavrizeni",
            "ucastnicirizeniz",
            "nazevspravnihoorganu",
          ];
          for (const divId of divIds) {
            const re = new RegExp(
              `id="${divId}"[^>]*>[\\s\\S]*?class="det-textval[^"]*"[^>]*>([\\s\\S]*?)</span>`,
              "i",
            );
            const m = detHtml.match(re);
            if (m?.[1]) {
              detail[divId] = stripHtml(m[1]).trim() || undefined;
            }
          }
        }
      } catch {
        // detail is optional
      }

      const decisionDate = detail.datumvydanirozhodnuti
        ? parseCeDate(detail.datumvydanirozhodnuti)
        : undefined;
      const decisionType =
        detail.druhdokumentuavyrokrozhodnuti?.toLowerCase();

      // Parse
      const parsed = parseNssDecisionHtml({
        caseNumber,
        ecli: detail.ecli,
        court: "Nejvyšší správní soud",
        decisionDate,
        decisionType,
        sourceUrl: `${BASE}/DokumentDetail/Index/${docId}`,
        html,
        detailMetadata: detail,
      });

      const slug = slugify(caseNumber);
      const id = generateId();

      // Build metadata JSONB
      const metadata: Record<string, unknown> = {};
      if (detail.soudcezpravodaj) {metadata.judge = detail.soudcezpravodaj;}
      if (detail.soudsenat) {metadata.senate = detail.soudsenat;}
      if (detail.oblastupravy) {metadata.legalArea = detail.oblastupravy;}
      if (detail.vyrokrozhodnuti) {metadata.outcome = detail.vyrokrozhodnuti;}
      if (detail.typrizeni) {metadata.caseType = detail.typrizeni;}
      if (detail.stavrizeni) {metadata.caseStatus = detail.stavrizeni;}
      if (detail.ucastnicirizeniz) {metadata.parties = detail.ucastnicirizeniz;}
      if (detail.nazevspravnihoorganu) {metadata.adminBody = detail.nazevspravnihoorganu;}

      // Insert
      await db`
        INSERT INTO case_law_decisions (
          id, source_id, case_number, slug, ecli, court,
          country, language, decision_date, decision_type,
          fulltext, source_url
        ) VALUES (
          ${id}, 'test_cz_nss', ${caseNumber}, ${slug},
          ${detail.ecli ?? null}, 'Nejvyšší správní soud',
          'CZE', 'cs', ${decisionDate ?? null},
          ${decisionType ?? null},
          ${parsed.fulltext}, ${`${BASE}/DokumentDetail/Index/${docId}`}
        )
        ON CONFLICT (source_id, case_number, language)
        DO UPDATE SET
          fulltext = EXCLUDED.fulltext,
          ecli = EXCLUDED.ecli,
          decision_date = EXCLUDED.decision_date,
          decision_type = EXCLUDED.decision_type
      `;

      // Update JSONB columns
      const astStr = JSON.stringify(parsed.documentAst);
      const metaStr = JSON.stringify(metadata);
      await db.unsafe(
        `UPDATE case_law_decisions
         SET document_ast = $1::jsonb,
             metadata = $3::jsonb
         WHERE case_number = $2 AND language = 'cs'
           AND source_id = 'test_cz_nss'`,
        [astStr, caseNumber, metaStr],
      );

      const blockCount =
        parsed.documentAst.blocks.length;
      console.log(
        `  ${caseNumber} ✓ (${blockCount} blocks)`,
      );
      success++;

      await Bun.sleep(300);
  }

  console.log(`\nDone: ${success} NSS decisions seeded`);
  process.exit(0);
};

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
