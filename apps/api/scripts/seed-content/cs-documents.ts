// The Czech firm Hartvich & Partneři: the documents its seeded matters list,
// their extracted bodies and the three e-mails of the Meridian / akvizice
// spis. Czech law, Czech parties and Czech file names (ASCII, underscores).
import { MARKETING_LOCALE_MARKERS } from "@stll/playwright-tools/marketing-locales";

import type { SeedEmail, StandardMatterLabel } from "./types";

const MARKERS = MARKETING_LOCALE_MARKERS.cs;

export const CS_SPA_DOCUMENT_NAME = "Smlouva_o_koupi_podilu.pdf";

export const CS_EMAIL_FILE_NAMES = [
  "Closing_zitra_kontrolni_seznam.eml",
  "Fwd_ERU_podminka_c_7.eml",
  "Aktualizace_pro_klienta.eml",
] as const;

type CsEmailFileName = (typeof CS_EMAIL_FILE_NAMES)[number];

export const CS_EMAILS = {
  "Closing_zitra_kontrolni_seznam.eml": {
    from: "Ing. Martin Kolář <martin.kolar@severka.example>",
    to: [
      "Mgr. Alena Jandová <alena.jandova@hartvich.example>",
      "Ing. Pavel Sýkora <pavel.sykora@svratka-holding.example>",
    ],
    cc: [
      "Petra Hartvichová <petra.hartvichova@hartvich.example>",
      "Transakční tým <closing@severka.example>",
    ],
    date: "Thu, 16 Jul 2026 17:42:00 +0200",
    subject: "Zítřejší closing: finální kontrolní seznam a tok plateb",
    textBody: `Dobrý den všem,

podpis smlouvy o koupi podílu proběhne zítra v 9:00 v kanceláři Hartvich & Partneři v Praze. Přiložený tok plateb prosím považujte za konečný, pokud paní Mgr. Jandová do 8:30 nerozešle jeho novou verzi.

Částka 25 000 000 Kč složená v advokátní úschově nesmí být uvolněna, dokud nebudou písemně potvrzeny obě podpisové strany a vzdání se odkládací podmínky č. 7.

Poslední úkoly:
1. Ing. Sýkora: do 8:15 doručit podepsaný souhlas společnosti Meridian se změnou kontroly.
2. Já: potvrdit odesílací účet končící 2048.
3. Mgr. Jandová: po kontrole všech podpisů odeslat e-mail o dokončení transakce.

Pokud se přes noc cokoli změní, odpovězte prosím do tohoto vlákna, nezakládejte nové.

S pozdravem
Martin Kolář
finanční ředitel, Severka Robotics a.s.`,
    htmlBody: `<p>Dobrý den všem,</p>
<p>podpis smlouvy o koupi podílu proběhne zítra v <strong>9:00</strong> v kanceláři Hartvich &amp; Partneři v Praze. Přiložený tok plateb prosím považujte za konečný, pokud paní Mgr. Jandová do 8:30 nerozešle jeho novou verzi.</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0">
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Podpis</strong></td><td style="border:1px solid #d1d5db;padding:8px">17. 7. 2026, 9:00, Praha</td></tr>
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Advokátní úschova</strong></td><td style="border:1px solid #d1d5db;padding:8px">25 000 000 Kč</td></tr>
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Podmínka uvolnění</strong></td><td style="border:1px solid #d1d5db;padding:8px">Podpisy + vzdání se podmínky č. 7</td></tr>
</table>
<p><strong>Částka 25 000 000 Kč složená v advokátní úschově nesmí být uvolněna, dokud nebudou písemně potvrzeny obě podpisové strany a vzdání se odkládací podmínky č. 7.</strong></p>
<p>Poslední úkoly:</p>
<ol>
  <li>Ing. Sýkora: do 8:15 doručit podepsaný souhlas společnosti Meridian se změnou kontroly.</li>
  <li>Já: potvrdit odesílací účet končící 2048.</li>
  <li>Mgr. Jandová: po kontrole všech podpisů odeslat e-mail o dokončení transakce.</li>
</ol>
<p>Pokud se přes noc cokoli změní, odpovězte prosím do tohoto vlákna, nezakládejte nové.</p>
<p>S pozdravem<br>Martin Kolář<br>finanční ředitel, Severka Robotics a.s.</p>`,
    attachments: [
      {
        type: "pdf",
        fileName: "Tok_plateb_finalni.pdf",
        title: "Finální tok plateb",
        bodyText:
          "Tok plateb k dokončení akvizice Svratka Pohony s.r.o. Advokátní úschova: 25 000 000 Kč. Uvolnění až po potvrzení podpisových stran a vzdání se podmínky č. 7 advokátní kanceláří Hartvich & Partneři.",
      },
      {
        type: "text",
        fileName: "Kontakty_closing.txt",
        bodyText:
          "Transakční advokát: Mgr. Alena Jandová\nÚschova: +420 224 010 204\nTelefonický most k dokončení: 8:45",
      },
    ],
  },
  "Fwd_ERU_podminka_c_7.eml": {
    from: "Mgr. Alena Jandová <alena.jandova@hartvich.example>",
    to: ["Ing. Martin Kolář <martin.kolar@severka.example>"],
    cc: ["Transakční tým <closing@severka.example>"],
    date: "Wed, 15 Jul 2026 14:18:00 +0200",
    subject: "Fwd: ERÚ vydal rozhodnutí — podmínka č. 7 zůstává otevřená",
    textBody: `Dobrý den, pane inženýre,

Energetický regulační úřad vydal rozhodnutí o změně licence na distribuci elektřiny pro lokální distribuční soustavu v areálu Kuřim. Odkládací podmínka č. 7 ale zůstává otevřená: rozhodnutí ukládá doložit aktualizovaný harmonogram připojení odběrných míst nejpozději do 20. 7. 2026.

Doporučuji: k dokončení transakce přistoupit jen tehdy, pokud prodávající podepíše přiložený závazek a částka 25 000 000 Kč zůstane v advokátní úschově.

---------- Přeposlaná zpráva ---------
Od: Podatelna ERÚ <podatelna@eru.example>
Datum: st 15. 7. 2026 v 13:52
Předmět: Rozhodnutí č. j. 08417-6/2026-ERU
Komu: Mgr. Alena Jandová <alena.jandova@hartvich.example>

Energetický regulační úřad mění licenci držitele Svratka Pohony s.r.o. s podmínkou č. 7. Držitel licence předloží aktualizovaný harmonogram připojení nejpozději do 20. července 2026.

S pozdravem
Alena Jandová`,
    htmlBody: `<p>Dobrý den, pane inženýre,</p>
<p>Energetický regulační úřad vydal rozhodnutí o změně licence na distribuci elektřiny pro lokální distribuční soustavu v areálu Kuřim. <strong>Odkládací podmínka č. 7 ale zůstává otevřená</strong>: rozhodnutí ukládá doložit aktualizovaný harmonogram připojení odběrných míst nejpozději do 20. 7. 2026.</p>
<p>Doporučuji: k dokončení transakce přistoupit jen tehdy, pokud prodávající podepíše přiložený závazek a částka 25 000 000 Kč zůstane v advokátní úschově.</p>
<div class="gmail_quote" style="border-left:3px solid #d1d5db;margin:20px 0;padding-left:16px;color:#4b5563">
  <div>---------- Přeposlaná zpráva ---------</div>
  <div><strong>Od:</strong> Podatelna ERÚ &lt;podatelna@eru.example&gt;</div>
  <div><strong>Datum:</strong> st 15. 7. 2026 v 13:52</div>
  <div><strong>Předmět:</strong> Rozhodnutí č. j. 08417-6/2026-ERU</div>
  <div><strong>Komu:</strong> Mgr. Alena Jandová &lt;alena.jandova@hartvich.example&gt;</div>
  <p>Energetický regulační úřad mění licenci držitele Svratka Pohony s.r.o. s podmínkou č. 7. Držitel licence předloží aktualizovaný harmonogram připojení nejpozději do 20. července 2026.</p>
</div>
<p>S pozdravem<br>Alena Jandová</p>`,
    attachments: [
      {
        type: "pdf",
        fileName: "Zavazek_prodavajiciho_podminka_7.pdf",
        title: "Závazek prodávajícího — podmínka č. 7",
        bodyText:
          "Prodávající Svratka Holding, s.r.o. se zavazuje zajistit předložení aktualizovaného harmonogramu připojení Energetickému regulačnímu úřadu do 20. 7. 2026 a souhlasí, že částka 25 000 000 Kč zůstane v advokátní úschově do písemného potvrzení splnění.",
      },
    ],
  },
  "Aktualizace_pro_klienta.eml": {
    from: "Petra Hartvichová <petra.hartvichova@hartvich.example>",
    to: [
      "Ing. Tereza Vrbová <tereza.vrbova@severka.example>",
      "Ing. Martin Kolář <martin.kolar@severka.example>",
    ],
    cc: ["Mgr. Klára Nováková <klara.novakova@hartvich.example>"],
    date: "Tue, 14 Jul 2026 11:06:00 +0200",
    subject: "Stav transakce Svratka Pohony a smlouvy s Meridianem",
    textBody: `Vážená paní inženýrko, vážený pane inženýre,

podpis smlouvy o koupi podílu ve společnosti Svratka Pohony s.r.o. zůstává naplánován na 17. 7. 2026 v Praze. Představenstvo i dozorčí rada již transakci schválily, další korporátní souhlasy nejsou potřeba.

Otevřené body:
1. Rozhodnutí ERÚ o změně licence k lokální distribuční soustavě očekáváme v nejbližších dnech (odkládací podmínka č. 7).
2. Meridian Precision Components GmbH přislíbil souhlas se změnou kontroly; podepsaný dokument dorazí nejpozději ráno v den podpisu.
3. Kolegyně Mgr. Nováková dokončuje revizi rámcové smlouvy o dodávkách s Meridianem; připomínky k odpovědnosti za vady a k cenové doložce posíláme dnes odpoledne.

Částka 25 000 000 Kč zůstane v advokátní úschově až do písemného potvrzení splnění podmínky č. 7.

S pozdravem
Petra Hartvichová
Hartvich & Partneři`,
    htmlBody: `<p>Vážená paní inženýrko, vážený pane inženýre,</p>
<p>podpis smlouvy o koupi podílu ve společnosti Svratka Pohony s.r.o. zůstává naplánován na <strong>17. 7. 2026</strong> v Praze. Představenstvo i dozorčí rada již transakci schválily, další korporátní souhlasy nejsou potřeba.</p>
<p>Otevřené body:</p>
<ol>
  <li>Rozhodnutí ERÚ o změně licence k lokální distribuční soustavě očekáváme v nejbližších dnech (odkládací podmínka č. 7).</li>
  <li>Meridian Precision Components GmbH přislíbil souhlas se změnou kontroly; podepsaný dokument dorazí nejpozději ráno v den podpisu.</li>
  <li>Kolegyně Mgr. Nováková dokončuje revizi rámcové smlouvy o dodávkách s Meridianem; připomínky k odpovědnosti za vady a k cenové doložce posíláme dnes odpoledne.</li>
</ol>
<p><strong>Částka 25 000 000 Kč zůstane v advokátní úschově až do písemného potvrzení splnění podmínky č. 7.</strong></p>
<p>S pozdravem<br>Petra Hartvichová<br>Hartvich &amp; Partneři</p>`,
    attachments: [],
  },
} as const satisfies Record<CsEmailFileName, SeedEmail>;

export const CS_MATTER_DOCUMENTS = {
  "ws-akvizice-energo": [
    CS_SPA_DOCUMENT_NAME,
    "Zprava_o_pravni_proverce.pdf",
    "Rozhodnuti_predstavenstva_Severka.docx",
    "Znalecky_posudek_oceneni_podilu.pdf",
    MARKERS.safeAgreementFileName,
    MARKERS.redactedExtractFileName,
    MARKERS.supplierAgreementFileName,
    ...CS_EMAIL_FILE_NAMES,
  ],
  "ws-stavebni-spor": [
    "Zaloba_o_nahradu_skody.pdf",
    "Znalecky_posudek_stavba.pdf",
    "Protokol_o_mistnim_setreni.docx",
    "Doplneni_dukaznich_navrhu.pdf",
  ],
  "ws-due-diligence": [
    "Kontrolni_seznam_pravni_proverky.pdf",
    "Schema_struktury_skupiny.pdf",
    "Navrh_smlouvy_o_koupi_podilu.docx",
    "Zprava_o_regulatornim_souladu.pdf",
  ],
  "ws-pracovni-spory": [
    "Vypoved_z_pracovniho_pomeru.pdf",
    "Zaloba_o_neplatnost_vypovedi.pdf",
    "Pracovni_smlouva.docx",
    "Svedecka_vypoved.pdf",
  ],
  "ws-compliance-ceska-energie": [
    "Compliance_program_2026.pdf",
    "Hodnoceni_compliance_rizik.pdf",
    "Zprava_interniho_auditu.docx",
    "Skoleni_compliance_2026.pdf",
  ],
  "ws-reorganizace": [
    "Plan_reorganizace_skupiny.pdf",
    "Projekt_rozdeleni_odstepenim.pdf",
    "Zapis_z_valne_hromady.docx",
    "Schema_holdingove_struktury.pdf",
  ],
  "ws-cross-border": [
    "Term_sheet_Projekt_Dunaj.pdf",
    "Regulatorni_analyza_spojeni.pdf",
    "Navrh_kupni_smlouvy_Dunaj.docx",
    "Analyza_soutezniho_prava.pdf",
  ],
  "ws-gdpr-audit": [
    "Analyza_souladu_GDPR.pdf",
    "Smlouva_o_zpracovani_osobnich_udaju.pdf",
    "Posouzeni_vlivu_DPIA.docx",
    "Zasady_ochrany_osobnich_udaju.pdf",
  ],
} satisfies Record<StandardMatterLabel, readonly string[]>;

/**
 * Extracted text of every document above except the supplier agreement
 * (built from its tracked-change paragraphs) and the e-mails.
 */
export const CS_DOCUMENT_TEXTS: Record<string, string> = {
  // ws-akvizice-energo
  [CS_SPA_DOCUMENT_NAME]: `SMLOUVA O KOUPI PODÍLU
uzavřená podle § 2079 a násl. zákona č. 89/2012 Sb., občanský zákoník, a § 207 a násl. zákona č. 90/2012 Sb., o obchodních korporacích

Smluvní strany:
1. Prodávající: Svratka Holding, s.r.o., IČO: 24816073, se sídlem Hybešova 726/42, 602 00 Brno, zastoupená Ing. Pavlem Sýkorou, jednatelem
2. Kupující: Severka Robotics a.s., IČO: 08417265, se sídlem Purkyňova 2875/107, 612 00 Brno, zastoupená Ing. Terezou Vrbovou, předsedkyní představenstva, a Ing. Martinem Kolářem, místopředsedou představenstva

Článek I – Předmět smlouvy
1.1 Prodávající převádí na Kupujícího obchodní podíl odpovídající 100% účasti ve společnosti Svratka Pohony s.r.o., IČO: 27394018, se sídlem Blanenská 1288, 664 34 Kuřim, zapsané v obchodním rejstříku vedeném Krajským soudem v Brně, oddíl C, vložka 51842 (dále jen „Cílová společnost“).
1.2 Podíl odpovídá vkladu 20 000 000 Kč, který je plně splacen. O podílu nebyl vydán kmenový list.

Článek II – Kupní cena
2.1 Kupní cena činí 248 000 000 Kč (slovy: dvě stě čtyřicet osm milionů korun českých).
2.2 Kupní cena bude uhrazena takto:
  a) 210 500 000 Kč ke Dni vypořádání na účet Prodávajícího;
  b) 25 000 000 Kč složením do advokátní úschovy u Hartvich & Partneři, advokátní kancelář, s.r.o., k zajištění nároků z prohlášení a záruk a splnění podmínky č. 7;
  c) 12 500 000 Kč jako doplatek kupní ceny (earn-out) podle dosažené EBITDA za rok 2027.

Článek III – Prohlášení a záruky
3.1 Prodávající prohlašuje a zaručuje, že:
  a) je výlučným vlastníkem podílu, který není zatížen zástavním právem ani jiným právem třetí osoby;
  b) Cílová společnost nemá splatné závazky po lhůtě splatnosti přesahující 3 000 000 Kč;
  c) soudní a správní řízení vedená proti Cílové společnosti nepřesahují souhrnně 2 000 000 Kč.

Článek IV – Odkládací podmínky
4.1 Dokončení transakce je podmíněno splněním těchto odkládacích podmínek:
  (1) povolením spojení soutěžitelů Úřadem pro ochranu hospodářské soutěže;
  (2) souhlasem společnosti Meridian Precision Components GmbH se změnou kontroly;
  (3) až (6) podmínkami uvedenými v příloze č. 3;
  (7) pravomocným rozhodnutím Energetického regulačního úřadu o změně licence na distribuci elektřiny v lokální distribuční soustavě Kuřim.

V Praze dne 17. července 2026`,

  "Zprava_o_pravni_proverce.pdf": `ZPRÁVA O PRÁVNÍ PROVĚRCE (DUE DILIGENCE)
Cílová společnost: Svratka Pohony s.r.o.
Klient: Severka Robotics a.s.

1. SHRNUTÍ
Právní prověrka proběhla v období 1.–26. června 2026. Přezkoumali jsme celkem 412 dokumentů v datové místnosti. Celkové riziko hodnotíme jako STŘEDNÍ.

2. KORPORÁTNÍ STRUKTURA
- Základní kapitál: 20 000 000 Kč, plně splacen
- Jediný společník: Svratka Holding, s.r.o.
- Jednatelé: Ing. Libor Hanák, Ing. Pavel Sýkora (každý jedná samostatně)
- Prokura: nebyla udělena

3. IDENTIFIKOVANÁ RIZIKA
3.1 Vysoká rizika:
  - Licence ERÚ na distribuci elektřiny v lokální distribuční soustavě Kuřim vyžaduje před dokončením změnu (odkládací podmínka č. 7)
  - Rámcová smlouva o dodávkách s Meridian Precision Components GmbH obsahuje doložku o změně kontroly s právem dodavatele smlouvu vypovědět

3.2 Střední rizika:
  - Pracovněprávní spor o neplatnost výpovědi (expozice cca 1 400 000 Kč)
  - Nájemní smlouva ke skladu v Kuřimi končí 03/2027, bez opce na prodloužení
  - Zástavní právo k výrobní hale ve prospěch financující banky

3.3 Nízká rizika:
  - Drobné nesrovnalosti v zápisu staveb do katastru nemovitostí
  - Chybějící záznamy o činnostech zpracování (čl. 30 GDPR) u dvou zpracovatelů

4. DOPORUČENÍ
  a) Podmínit dokončení transakce pravomocným rozhodnutím ERÚ o změně licence
  b) Před podpisem získat písemný souhlas společnosti Meridian se změnou kontroly
  c) Sjednat zvláštní odškodnění pro probíhající pracovněprávní spor
  d) Ponechat 25 000 000 Kč z kupní ceny v advokátní úschově

Zpracovala: Hartvich & Partneři, advokátní kancelář, s.r.o.
Datum: 30. června 2026`,

  "Rozhodnuti_predstavenstva_Severka.docx": `SEVERKA ROBOTICS A.S.
IČO: 08417265, se sídlem Purkyňova 2875/107, 612 00 Brno

ROZHODNUTÍ PŘEDSTAVENSTVA PŘIJATÉ MIMO ZASEDÁNÍ (PER ROLLAM)

Představenstvo společnosti Severka Robotics a.s. v souladu se stanovami společnosti přijímá tato rozhodnutí:

1. Představenstvo schvaluje uzavření smlouvy o koupi podílu, jejímž předmětem je 100% obchodní podíl ve společnosti Svratka Pohony s.r.o., IČO: 27394018, za kupní cenu 248 000 000 Kč.

2. Představenstvo schvaluje uzavření smlouvy o budoucím podílu (SAFE) se společností Lipová Ventures I, SICAV, a.s. na investiční částku 12 000 000 Kč se stropem ocenění 320 000 000 Kč (post-money).

3. Představenstvo konstatuje, že dozorčí rada udělila k oběma transakcím předchozí souhlas dne 13. 7. 2026 podle čl. 21 odst. 3 písm. d) stanov.

4. Představenstvo pověřuje Ing. Terezu Vrbovou a Ing. Martina Koláře, aby smlouvy podepsali a učinili všechna jednání nezbytná k dokončení obou transakcí.

Hlasování: pro 3 členové, proti 0, zdržel se 0.

V Brně dne 15. července 2026

Ing. Tereza Vrbová, předsedkyně představenstva
Ing. Martin Kolář, místopředseda představenstva
Mgr. Ondřej Dušek, člen představenstva`,

  "Znalecky_posudek_oceneni_podilu.pdf": `ZNALECKÝ POSUDEK č. 214-26/2026
o stanovení tržní hodnoty 100% obchodního podílu ve společnosti Svratka Pohony s.r.o.

Zadavatel: Severka Robotics a.s., Purkyňova 2875/107, 612 00 Brno
Znalec: doc. Ing. Jiří Kratochvíl, Ph.D., znalec v oboru ekonomika, odvětví oceňování podniků, zapsaný v seznamu znalců vedeném Ministerstvem spravedlnosti

ÚČEL POSUDKU:
Stanovení tržní hodnoty podílu pro účely kupní smlouvy a interního schválení transakce orgány zadavatele.

ZÁVĚR:
Tržní hodnota 100% obchodního podílu ve společnosti Svratka Pohony s.r.o. k datu ocenění 31. 5. 2026 činí:

  236 000 000 Kč až 262 000 000 Kč

Střední hodnota: 249 400 000 Kč

Metoda ocenění: kombinace výnosové metody DCF (váha 60 %) a metody tržního porovnání (váha 40 %).

Klíčové předpoklady:
- WACC: 9,4 %
- Dlouhodobé tempo růstu: 2,0 %
- Plánovaná EBITDA 2026: 41 800 000 Kč
- Plánovaná EBITDA 2027: 45 300 000 Kč
- Multiplikátor EV/EBITDA srovnatelných společností: 5,6x–6,2x
- Čistý dluh k datu ocenění: 9 600 000 Kč

ZNALECKÁ DOLOŽKA:
Znalec si je vědom následků vědomě nepravdivého znaleckého posudku. Posudek je zapsán v evidenci posudků pod pořadovým číslem 214/2026.

V Brně dne 3. července 2026`,

  [MARKERS.safeAgreementFileName]: `INTERNÍ NÁVRH — POUZE K REVIZI

SMLOUVA O BUDOUCÍM PODÍLU (SAFE)
uzavřená podle § 1746 odst. 2 zákona č. 89/2012 Sb., občanský zákoník

Smluvní strany:
1. Severka Robotics a.s., IČO: 08417265, se sídlem Purkyňova 2875/107, 612 00 Brno, zapsaná v obchodním rejstříku vedeném Krajským soudem v Brně, oddíl B, vložka 8417 (dále jen „Společnost“)
2. Lipová Ventures I, SICAV, a.s., IČO: 19283746, se sídlem Rybná 716/24, 110 00 Praha 1 (dále jen „Investor“)

Článek I – Předmět smlouvy
1.1 Investor poskytne Společnosti investiční částku 12 000 000 Kč (dále jen „Investiční částka“) nejpozději do 31. 7. 2026.
1.2 Společnost se zavazuje vydat Investorovi za Investiční částku akcie za podmínek této smlouvy.

Článek II – Události
2.1 Kvalifikované investiční kolo. Získá-li Společnost před skončením této smlouvy investici nejméně 40 000 000 Kč, navrhne valné hromadě zvýšení základního kapitálu s vyloučením přednostního práva ostatních akcionářů a Investor upíše počet prioritních akcií odpovídající podílu Investiční částky a Konverzní ceny.
2.2 Prodej Společnosti. Dojde-li k převodu kontroly nad Společností, náleží Investorovi vyšší z částek: Investiční částka, nebo částka připadající na akcie, které by Investor získal konverzí za cenu odvozenou ze Stropu ocenění.
2.3 Zrušení Společnosti. Bude-li Společnost zrušena, vyplatí Investorovi Investiční částku přednostně před rozdělením likvidačního zůstatku mezi akcionáře.

Článek III – Definice
„Strop ocenění“ znamená 320 000 000 Kč (post-money).
„Sleva“ znamená 20 % z ceny akcie v Kvalifikovaném investičním kole.
„Konverzní cena“ znamená nižší z cen určených podle Stropu ocenění a podle Slevy.

Článek IV – Prohlášení Společnosti
Společnost je řádně založena a existuje podle českého práva. Uzavření této smlouvy schválilo představenstvo s předchozím souhlasem dozorčí rady.

Článek V – Prohlášení Investora
Investor je oprávněn tuto smlouvu uzavřít a nabývá práva z ní pro investiční účely, nikoli za účelem dalšího prodeje.

Článek VI – Závěrečná ustanovení
Smlouva se řídí českým právem. Změny jsou možné jen písemně se souhlasem Společnosti a Investora.

Za Severka Robotics a.s.: Ing. Tereza Vrbová, předsedkyně představenstva
Za Lipová Ventures I, SICAV, a.s.: Ing. Jakub Říha, pověřený zmocněnec`,

  [MARKERS.redactedExtractFileName]: `DŮVĚRNÉ — ANONYMIZOVANÁ KOPIE PRO REVIZI

PROJEKT SVRATKA
VÝTAH ZE ZPRÁVY O PRÁVNÍ PROVĚRCE (DUE DILIGENCE)

1. SMLUVNÍ STRANY

Cílová společnost: ████████████████████, IČO: ████████
Prodávající: ██████████████████████████
Kupující: Severka Robotics a.s.

2. HODNOTA TRANSAKCE

Navrhovaná kupní cena činí ███████████ Kč a podléhá úpravě o čistý dluh a pracovní kapitál podle přílohy č. 4. Účet prodávajícího pro výplatu: ██████████/████.

3. KLÍČOVÁ ZJIŠTĚNÍ

3.1 Cílová společnost je stranou podstatné rámcové smlouvy o dodávkách se společností ███████████████████. Smlouva obsahuje doložku o změně kontroly, podle které je k dokončení transakce nutný předchozí písemný souhlas dodavatele.

3.2 Pracovněprávní spor se zaměstnancem ████████████████, nar. ██. ██. ████, bytem ██████████████████████, dosud nebyl pravomocně skončen. Externí advokát odhaduje maximální expozici na ████████ Kč.

3.3 Jednatel ██████████████ (r. č. ██████/████) je současně společníkem konkurenční společnosti; zákaz konkurence podle § 199 zákona o obchodních korporacích nebyl řešen.

4. DOPORUČENÍ

Zajistit souhlas se změnou kontroly, sjednat zvláštní odškodnění pro probíhající spor a ponechat částku ██████████ Kč z kupní ceny v advokátní úschově do jeho skončení.

Připraveno pro interní revizi. Jména osob, rodná čísla, adresy, čísla účtů a obchodně citlivé částky byly anonymizovány.`,

  // ws-stavebni-spor
  "Zaloba_o_nahradu_skody.pdf": `ŽALOBA O NÁHRADU ŠKODY

Městský soud v Brně
Husova 15
657 33 Brno

Žalobce: Brněnská stavební společnost, s.r.o., IČO: 46972315, se sídlem Heršpická 813/5, 639 00 Brno
Právní zástupce: Mgr. Alena Jandová, advokátka, ev. č. ČAK 17342, Hartvich & Partneři, advokátní kancelář, s.r.o.

Žalovaný: Monolit Komárov s.r.o., IČO: 03518742, se sídlem Kšírova 552/45, 619 00 Brno

Žalovaná částka: 9 840 000 Kč s příslušenstvím

I. Skutkový stav
Žalovaný provedl na základě smlouvy o dílo č. SD-2023/118 ze dne 6. 3. 2023 jako subdodavatel monolitickou železobetonovou konstrukci podzemních garáží bytového domu „Rezidence Svratecké nábřeží“ v Brně-jihu. Dílo bylo předáno 28. 2. 2024. V listopadu 2024 se v garážích objevily průsaky podzemní vody a trhliny ve stěnách. Žalobce musel vady na vlastní náklady odstranit vůči investorovi.

II. Znalecký posudek
Podle znaleckého posudku Ing. Radka Pospíšila, Ph.D. (č. 46-11/2025) je příčinou vad použití betonu nižší pevnostní třídy (C20/25 místo projektovaného vodonepropustného C30/37) a provedení pracovních spár bez těsnicích prvků.

III. Právní posouzení
Žalovaný porušil povinnost provést dílo s vlastnostmi podle smlouvy (§ 2615 občanského zákoníku) a odpovídá za škodu tím způsobenou podle § 2913 občanského zákoníku.

IV. Návrh rozsudku
Žalovaný je povinen zaplatit žalobci částku 9 840 000 Kč se zákonným úrokem z prodlení od 15. 4. 2025 do zaplacení, sestávající z:
  a) 7 260 000 Kč – náklady na sanaci konstrukce;
  b) 1 580 000 Kč – smluvní pokuta uhrazená investorovi za prodlení;
  c) 1 000 000 Kč – znalecké a projektové náklady.

V Praze dne 12. května 2025`,

  "Znalecky_posudek_stavba.pdf": `ZNALECKÝ POSUDEK č. 46-11/2025
Předmět: Posouzení příčin průsaků a trhlin v podzemních garážích bytového domu „Rezidence Svratecké nábřeží“, Brno-jih

Zadavatel: Brněnská stavební společnost, s.r.o.
Znalec: Ing. Radek Pospíšil, Ph.D., znalec v oboru stavebnictví, odvětví stavby obytné a průmyslové

NÁLEZ:
1. Na obvodových stěnách 1. PP bylo zjištěno 14 trhlin šířky 0,4–1,9 mm, z nichž 9 vykazuje aktivní průsak vody.
2. Jádrové vývrty prokázaly pevnost betonu v tlaku 26,1 MPa (odpovídá třídě C20/25), zatímco projekt předepisuje vodonepropustný beton C30/37 XC2 XA1.
3. Pracovní spáry mezi základovou deskou a stěnami nejsou opatřeny těsnicími plechy ani injektážními hadicemi.
4. Krycí vrstva výztuže činí průměrně 22 mm, projekt předepisuje 40 mm.

ZÁVĚR:
Příčinou zjištěných vad je:
  a) použití betonu nižší pevnostní třídy, než stanoví projekt;
  b) chybějící těsnění pracovních spár;
  c) nedodržení předepsaného krytí výztuže.
Všechny vady vznikly při provádění díla subdodavatelem a jsou důsledkem nedostatečné kontroly kvality.

Odhadované náklady na sanaci: 7 050 000–7 480 000 Kč.

V Brně dne 28. března 2025`,

  "Protokol_o_mistnim_setreni.docx": `PROTOKOL O MÍSTNÍM ŠETŘENÍ

Spis: Brněnská stavební společnost, s.r.o. / Monolit Komárov s.r.o.
Místo: Brno-jih, bytový dům „Rezidence Svratecké nábřeží“, podzemní garáže 1. PP
Datum: 20. února 2025, 9:00–13:30

Přítomni:
- Ing. Radek Pospíšil, Ph.D. – znalec
- Mgr. Alena Jandová – právní zástupkyně Brněnské stavební společnosti, s.r.o.
- Ing. Tomáš Šťastný – stavbyvedoucí Brněnské stavební společnosti, s.r.o.
- Ing. Viktor Hájek – jednatel Monolit Komárov s.r.o.
- Bc. Lenka Křížová – technický dozor investora

Průběh šetření:
1. Vizuální prohlídka obvodových stěn a stropní desky – zjištěno 14 trhlin, z toho 9 s průsakem.
2. Odběr 6 jádrových vývrtů ze stěn a základové desky (vzorky J1–J6).
3. Měření krycí vrstvy výztuže profometrem – 16 měřicích bodů.
4. Sondy do pracovních spár ve dvou místech.
5. Fotodokumentace – celkem 112 snímků (příloha č. 1).

Vyjádření žalovaného:
Ing. Hájek namítl, že průsaky mohly vzniknout v důsledku dodatečného snížení hladiny podzemní vody při čerpání na sousední stavbě. Námitku posoudí znalec ve znaleckém posudku.

Protokol sepsán v Brně dne 20. února 2025.`,

  "Doplneni_dukaznich_navrhu.pdf": `DOPLNĚNÍ DŮKAZNÍCH NÁVRHŮ

Městský soud v Brně
sp. zn. 38 C 112/2025

Žalobce: Brněnská stavební společnost, s.r.o.
Žalovaný: Monolit Komárov s.r.o.

Žalobce v reakci na vyjádření žalovaného ze dne 30. 6. 2025 navrhuje provést tyto další důkazy:
1. Stavební deník žalovaného k dílu č. SD-2023/118 (k prokázání odchylek od projektové dokumentace).
2. Dodací listy dodavatele betonu za období 4–9/2023 (k prokázání dodané pevnostní třídy betonu).
3. Výslech svědka Ing. Tomáše Šťastného, stavbyvedoucího žalobce (k okolnostem převzetí díla a reklamace vad).
4. Hydrogeologický posudek k hladině podzemní vody v lokalitě ze dne 14. 7. 2025 (k vyvrácení námitky žalovaného).
5. Korespondence o reklamaci vad ze dne 22. 11. 2024 a 9. 12. 2024.

Žalobce trvá na svém návrhu v plném rozsahu.

V Praze dne 18. srpna 2025

Mgr. Alena Jandová, advokátka`,

  // ws-due-diligence
  "Kontrolni_seznam_pravni_proverky.pdf": `KONTROLNÍ SEZNAM PRÁVNÍ PROVĚRKY

Cílová společnost: Tercius Data s.r.o.
Klient: Zelený horizont investiční fond, SICAV, a.s.
Projekt: Projekt Atlas – právní due diligence
Stav ke dni: 20. 2. 2026

1. KORPORÁTNÍ DOKUMENTY
  [✓] Výpis z obchodního rejstříku
  [✓] Společenská smlouva (úplné znění)
  [✓] Seznam společníků a evidence skutečných majitelů
  [✗] Zápisy z valných hromad za poslední 3 roky (doloženy jen 2 roky)
  [✓] Plné moci a prokury

2. SMLOUVY
  [✓] Smlouvy s odběrateli (20 největších podle tržeb)
  [✓] Smlouvy s dodavateli
  [✗] Prověrka doložek o změně kontroly (probíhá v datové místnosti)
  [✓] Nájemní smlouvy

3. PRACOVNĚPRÁVNÍ OBLAST
  [✓] Pracovní smlouvy (vzor a odchylky)
  [✓] Kolektivní smlouva
  [✗] Zaměstnanecký opční program (chybí harmonogram nároků)
  [✓] Konkurenční doložky

4. DUŠEVNÍ VLASTNICTVÍ
  [✓] Patenty (3 CZ, 1 EP)
  [✓] Ochranné známky
  [✗] Audit licencí open source (čeká se)
  [✓] Licenční smlouvy k softwaru

5. SPORY
  [✓] Probíhající řízení (1 drobný pracovněprávní spor, 380 000 Kč)
  [✓] Regulatorní šetření (žádná)
  [✓] Daňové kontroly

Celkové plnění: 78 % (14 z 18 položek)
Chybějící podklady dodá prodávající do 6. 3. 2026.`,

  "Schema_struktury_skupiny.pdf": `SCHÉMA STRUKTURY SKUPINY – PROJEKT ATLAS

Tercius Data Group B.V. (Nizozemsko)
  │
  ├── 100% Tercius Data s.r.o. (Česká republika)
  │     ├── 51% Tercius Labs s.r.o. (Česká republika)
  │     └── 100% Tercius Services Kft. (Maďarsko)
  │
  ├── 100% Tercius Data GmbH (Německo)
  │     └── 100% Tercius Consulting AG (Švýcarsko)
  │
  └── 80% Tercius Data UK Ltd. (Spojené království)

Klíčové finanční údaje (konsolidace 2025):
- Tržby: 1 058 000 000 Kč
- EBITDA: 203 000 000 Kč
- Zaměstnanci: 312 (CZ 185, HU 45, DE 52, UK 30)
- Čistý dluh: 79 000 000 Kč

Regulatorní poznámky:
- Česká společnost je držitelem živnostenských oprávnění pro IT služby
- Česká společnost je od 1. 11. 2025 regulovanou službou podle zákona č. 264/2025 Sb., o kybernetické bezpečnosti
- Britská společnost vyžaduje oznámení FCA pro fintech modul`,

  "Navrh_smlouvy_o_koupi_podilu.docx": `SMLOUVA O KOUPI PODÍLU – NÁVRH v3.2

Smluvní strany:
(1) Tercius Data Group B.V., se sídlem Amsterdam, Nizozemsko („Prodávající“)
(2) Zelený horizont investiční fond, SICAV, a.s., se sídlem Praha („Kupující“)

Předmět: 100% obchodní podíl ve společnosti Tercius Data s.r.o.

ČLÁNEK 1 – DEFINICE
„Pracovní den“ znamená den, který není sobotou, nedělí ani svátkem v České republice nebo v Nizozemsku.
„Den vypořádání“ znamená pátý Pracovní den po splnění všech odkládacích podmínek.
„Podstatná nepříznivá změna“ znamená událost, která sníží EBITDA o více než 15 % oproti auditované účetní závěrce za rok 2025.

ČLÁNEK 2 – KUPNÍ CENA
2.1 Kupní cena činí 875 000 000 Kč (slovy: osm set sedmdesát pět milionů korun českých).
2.2 Kupní cena je stanovena mechanismem locked box k rozhodnému dni 31. 12. 2025.
2.3 Povolený únik hodnoty: mzdy, nájemné a běžné obchodní závazky.

ČLÁNEK 3 – ODKLÁDACÍ PODMÍNKY
3.1 Povolení spojení Úřadem pro ochranu hospodářské soutěže (bez zahájení druhé fáze řízení);
3.2 Souhlas klíčových odběratelů představujících více než 60 % tržeb;
3.3 Nenastání Podstatné nepříznivé změny mezi podpisem a Dnem vypořádání.

ČLÁNEK 4 – PROHLÁŠENÍ A ZÁRUKY
Prodávající prohlašuje, že informace v datové místnosti jsou ke dni podpisu pravdivé a úplné.

[ZBÝVAJÍCÍ USTANOVENÍ JSOU PŘEDMĚTEM JEDNÁNÍ]`,

  "Zprava_o_regulatornim_souladu.pdf": `ZPRÁVA O REGULATORNÍM SOULADU
Tercius Data s.r.o. – Projekt Atlas

1. OCHRANA OSOBNÍCH ÚDAJŮ (GDPR)
Stav: ČÁSTEČNĚ V SOULADU
- Smlouvy o zpracování uzavřeny s 12 z 15 zpracovatelů (3 chybí)
- Posouzení vlivu (DPIA) provedeno pro analytický modul
- Postup pro hlášení porušení zabezpečení je zaveden
- Chybí: jmenovaný pověřenec pro ochranu osobních údajů (zpracování ve velkém rozsahu)
Doporučení: jmenovat pověřence před vypořádáním; rozpočet cca 1 100 000 Kč ročně

2. KYBERNETICKÁ BEZPEČNOST
Stav: ČÁSTEČNĚ V SOULADU
- Registrace regulované služby u NÚKIB podána
- Chybí: dokumentace řízení rizik dodavatelského řetězce

3. ŽIVNOSTENSKÁ OPRÁVNĚNÍ
Stav: V SOULADU
- Všechna česká oprávnění platná; maďarské oprávnění obnoveno v říjnu 2025

4. PRACOVNÍ PRÁVO
Stav: V SOULADU S DROBNÝMI NEDOSTATKY
- Požadavky zákoníku práce splněny
- Evidence pracovní doby: 2 případy nesouladu ve 3. čtvrtletí 2025
- Kolektivní smlouva končí v březnu 2027
Úroveň rizika: NÍZKÁ

Celkové hodnocení rizika: NÍZKÉ AŽ STŘEDNÍ
Odhad nákladů na nápravu: 1 600 000–2 100 000 Kč`,

  // ws-pracovni-spory
  "Vypoved_z_pracovniho_pomeru.pdf": `VÝPOVĚĎ Z PRACOVNÍHO POMĚRU

Zaměstnavatel: Kovotech Vysočina a.s., IČO: 25319845, se sídlem Brněnská 5221/48, 586 01 Jihlava

Zaměstnanec: Ing. Radim Horák, nar. 3. 8. 1981, bytem Fritzova 4210/18, 586 01 Jihlava

Podle § 52 písm. c) zákoníku práce Vám dáváme výpověď z pracovního poměru pro nadbytečnost v důsledku organizační změny. Představenstvo společnosti rozhodlo dne 10. 12. 2025 o zrušení pozice vedoucího oddělení technické kontroly v závodě Jihlava, kterou zastáváte.

Výpovědní doba činí 2 měsíce. Podle § 51 odst. 1 zákoníku práce začíná dnem doručení této výpovědi.

Odstupné: Náleží Vám odstupné ve výši trojnásobku průměrného výdělku podle § 67 odst. 1 písm. c) zákoníku práce, tj. 214 500 Kč.

Výpověď byla předem projednána se základní organizací odborového svazu podle § 61 odst. 1 zákoníku práce dne 18. 12. 2025.

V Jihlavě dne 12. ledna 2026

Za zaměstnavatele: Ing. Jaroslav Bureš, personální ředitel`,

  "Zaloba_o_neplatnost_vypovedi.pdf": `ŽALOBA NA URČENÍ NEPLATNOSTI VÝPOVĚDI Z PRACOVNÍHO POMĚRU

Okresní soud v Jihlavě
Tolstého 1455/15
586 01 Jihlava

Žalobce: Ing. Radim Horák, nar. 3. 8. 1981, bytem Fritzova 4210/18, 586 01 Jihlava
Žalovaný: Kovotech Vysočina a.s., IČO: 25319845, se sídlem Brněnská 5221/48, 586 01 Jihlava

I. Skutkový stav
Žalovaný dal žalobci dne 12. 1. 2026 výpověď podle § 52 písm. c) zákoníku práce. Žalobce má výpověď za neplatnou z těchto důvodů:

1. Organizační změna nebyla skutečně provedena. Pozice vedoucího technické kontroly nebyla zrušena, pouze přejmenována na „manažer kvality“ a od 2. 2. 2026 ji zastává jiná zaměstnankyně.

2. Výpověď byla doručena v ochranné době. Žalobce byl od 9. 1. 2026 uznán dočasně práce neschopným, výpověď mu proto podle § 53 odst. 1 písm. a) zákoníku práce nemohla být dána.

3. Odborová organizace nebyla o výpovědi informována v dostatečném předstihu a s úplnými podklady.

II. Návrh rozsudku
Určuje se, že výpověď z pracovního poměru, kterou dal žalovaný žalobci dopisem ze dne 12. 1. 2026, je neplatná.

Žaloba je podána ve lhůtě 2 měsíců podle § 72 zákoníku práce.

V Jihlavě dne 20. dubna 2026
Ing. Radim Horák`,

  "Pracovni_smlouva.docx": `PRACOVNÍ SMLOUVA

Zaměstnavatel: Kovotech Vysočina a.s., IČO: 25319845, se sídlem Brněnská 5221/48, 586 01 Jihlava
Zaměstnanec: Ing. Radim Horák, nar. 3. 8. 1981

1. Druh práce: vedoucí oddělení technické kontroly
2. Místo výkonu práce: závod Jihlava, Brněnská 5221/48
3. Den nástupu do práce: 1. března 2017
4. Pracovní poměr se sjednává na dobu neurčitou
5. Zkušební doba: 3 měsíce
6. Mzda: 71 500 Kč měsíčně (mzdový výměr, příloha č. 1)
7. Týdenní pracovní doba: 37,5 hodiny
8. Dovolená: 5 týdnů v kalendářním roce
9. Výpovědní doba a její běh se řídí zákoníkem práce

Zaměstnanec potvrzuje, že byl před podpisem smlouvy seznámen s pracovním řádem, předpisy k zajištění bezpečnosti a ochrany zdraví při práci a s kolektivní smlouvou.

V Jihlavě dne 20. února 2017

Za zaměstnavatele: Ing. Jaroslav Bureš, personální ředitel
Zaměstnanec: Ing. Radim Horák`,

  "Svedecka_vypoved.pdf": `PROTOKOL O VÝSLECHU SVĚDKA

Okresní soud v Jihlavě
sp. zn. 9 C 87/2026

Svědkyně: Bc. Lucie Dvořáková, nar. 12. 4. 1989
Vztah k účastníkům: zaměstnankyně žalovaného, vedoucí personálního oddělení

Svědkyně byla poučena podle § 126 občanského soudního řádu o povinnosti vypovídat pravdivě a nic nezamlčet.

Výpověď:
„U společnosti Kovotech Vysočina pracuji od roku 2014, od roku 2020 jako vedoucí personálního oddělení. K organizační změně ze dne 10. 12. 2025 mohu uvést následující.

Návrh na zrušení pozice vedoucího technické kontroly připravil výrobní ředitel. Upozorňovala jsem, že by pan Horák mohl přejít na pozici vedoucího údržby, která byla tehdy volná. Bylo mi řečeno, že na tu pozici je již vybrán externí kandidát.

Pozici manažerky kvality obsadila od 2. 2. 2026 Ing. Kopecká. Náplň práce se s původní pozicí shoduje zhruba ze tří čtvrtin, nově přibyla odpovědnost za certifikaci ISO.

O pracovní neschopnosti pana Horáka jsem se dozvěděla až 13. 1. 2026, tedy den po předání výpovědi.“

Protokol přečten, svědkyně nemá námitek.

V Jihlavě dne 16. června 2026`,

  // ws-compliance-ceska-energie
  "Compliance_program_2026.pdf": `COMPLIANCE PROGRAM 2026
Vltavská energetika, a.s.

1. ÚVOD
Compliance program stanoví pravidla pro dodržování právních předpisů, regulatorních požadavků a etických norem ve skupině Vltavská energetika. Je součástí opatření, která po společnosti lze spravedlivě požadovat ve smyslu § 8 odst. 5 zákona č. 418/2011 Sb., o trestní odpovědnosti právnických osob.

2. PROTIKORUPČNÍ PRAVIDLA
2.1 Zakazuje se nabízet, poskytovat i přijímat úplatky (§ 331–334 trestního zákoníku).
2.2 Dary a pohoštění: nejvýše 2 000 Kč na osobu a rok, s povinnou evidencí v registru darů.
2.3 Sponzorské a charitativní dary schvaluje výhradně představenstvo.

3. STŘET ZÁJMŮ
Každý zaměstnanec oznámí střet zájmů formulářem SZ-01 do 5 pracovních dnů od jeho zjištění.

4. VELKOOBCHODNÍ TRH S ENERGIÍ (REMIT)
4.1 Zákaz obchodování na základě důvěrných informací a manipulace s trhem podle nařízení (EU) č. 1227/2011.
4.2 Podezřelé obchody hlásí oddělení obchodu bez zbytečného odkladu Energetickému regulačnímu úřadu.

5. OZNAMOVÁNÍ PROTIPRÁVNÍHO JEDNÁNÍ
Oznámení lze podat:
  a) e-mailem: oznameni@vltavska-energetika.example
  b) telefonicky: interní linka 5555
  c) osobně u příslušné osoby podle zákona č. 171/2023 Sb., o ochraně oznamovatelů
Ochrana oznamovatele před odvetnými opatřeními je zaručena.

6. SANKCE
Podle závažnosti porušení: kárné opatření, výpověď, trestní oznámení.

Platnost: 1. 1. 2026 – 31. 12. 2026
Schválila: Ing. Hana Kubátová, ředitelka compliance`,

  "Hodnoceni_compliance_rizik.pdf": `HODNOCENÍ COMPLIANCE RIZIK
Vltavská energetika, a.s. – roční přezkum 2026

SHRNUTÍ
Celkové hodnocení: STŘEDNÍ RIZIKO

1. KORUPČNÍ RIZIKA
- Veřejné zakázky obcí a krajů na dodávky energie: STŘEDNÍ
- Povolovací řízení k novým zdrojům: STŘEDNÍ
- Sponzoring regionálních akcí: NÍZKÉ

2. REMIT A OBCHODOVÁNÍ S ENERGIÍ
- Obchodní pozice na energetické burze: STŘEDNÍ (vysoké objemy, přeshraniční obchody)
- Přístup obchodníků k důvěrným informacím o odstávkách zdrojů: VYSOKÉ
- Hlášení transakcí ERÚ a ACER: v souladu, 2 opožděná hlášení v roce 2025

3. SANKCE A KONTROLA OBCHODNÍCH PARTNERŮ
- Obchodní partneři celkem: 1 247
- Partneři s vazbou na sankcionované osoby: 3 zjištěni, smlouvy ukončeny
- Ověření skutečného majitele: 98,7 % partnerů

4. STŘET ZÁJMŮ
- Podaná oznámení (2025): 41
- Případy řešené výborem pro audit: 3

5. DOPORUČENÍ
  a) Zavést automatickou kontrolu sankčních seznamů (nyní ručně jednou za 14 dní)
  b) Oddělit přístup obchodníků k informacím o plánovaných odstávkách
  c) Aktualizovat model hodnocení partnerů (naposledy 2023)

Zpracovala: Hartvich & Partneři, advokátní kancelář, s.r.o.
Datum: 28. února 2026`,

  "Zprava_interniho_auditu.docx": `ZPRÁVA INTERNÍHO AUDITU č. 2026/04
Vltavská energetika, a.s.

Oblast auditu: Proces schvalování dodavatelů
Období: 1. 1. – 30. 9. 2025
Auditor: Ing. Marek Vlček, CIA

ZJIŠTĚNÍ:
1. (VYSOKÁ PRIORITA) U 3 z 15 testovaných dodavatelů chybělo ověření skutečného majitele v evidenci skutečných majitelů. Jde o dodavatele s kumulativním obratem 12 500 000 Kč.

2. (STŘEDNÍ PRIORITA) Směrnice SM-07 vyžaduje u zakázek nad 5 000 000 Kč tříkolové výběrové řízení. U zakázek č. 2025/089 a 2025/112 proběhla jen dvě kola.

3. (NÍZKÁ PRIORITA) U 8 dodavatelských smluv uplynula doba trvání bez písemného prodloužení; plnění pokračuje na základě automatické prolongace.

DOPORUČENÍ:
1. Zavést automatické ověření skutečného majitele při registraci nového dodavatele v systému SAP.
2. Zavést schvalovací postup pro výjimky ze směrnice SM-07.
3. Nastavit upozornění 60 dnů před skončením smlouvy.

VYJÁDŘENÍ VEDENÍ:
Všechna doporučení přijata. Termín implementace: 31. 3. 2026.

V Praze dne 15. listopadu 2025`,

  "Skoleni_compliance_2026.pdf": `COMPLIANCE ŠKOLENÍ 2026
Vltavská energetika, a.s.

Modul 1: Protikorupční pravidla
- Co je úplatek: § 331 trestního zákoníku
- Příklady zakázaného jednání
- Jak reagovat na nabídku úplatku
- Test: 5 otázek (minimální skóre 80 %)

Modul 2: REMIT a důvěrné informace
- Co je důvěrná informace o trhu s energií
- Zákaz obchodování zasvěcených osob a manipulace s trhem
- Test: 5 otázek (minimální skóre 80 %)

Modul 3: Ochrana osobních údajů
- Práva subjektů údajů podle GDPR
- Bezpečné zacházení s daty zákazníků
- Co dělat při porušení zabezpečení
- Test: 5 otázek (minimální skóre 80 %)

Modul 4: Oznamování protiprávního jednání
- Kdy a jak podat oznámení
- Ochrana oznamovatele podle zákona č. 171/2023 Sb.
- Test: 3 otázky

Statistika účasti:
- Povinní zaměstnanci: 842
- Absolvovali: 819 (97,3 %)
- Průměrné skóre: 91 %
- Termín pro zbývající: 31. 12. 2026`,

  // ws-reorganizace
  "Plan_reorganizace_skupiny.pdf": `PLÁN REORGANIZACE SKUPINY KOVOTECH
Kovotech Vysočina a.s., IČO: 25319845

1. CÍLE REORGANIZACE
  a) Oddělit divizi přesného obrábění do samostatné společnosti připravené na vstup strategického investora
  b) Sloučit servisní dceřiné společnosti a snížit administrativní náklady
  c) Zjednodušit financování skupiny

2. PŘEMĚNY
2.1 Rozdělení odštěpením se vznikem nové společnosti:
  - Rozdělovaná společnost: Kovotech Vysočina a.s.
  - Nástupnická společnost: Kovotech Precision s.r.o. (nově vznikající)
  - Rozhodný den: 1. 1. 2026

2.2 Fúze sloučením:
  - Zanikající společnost: Kovotech Nástroje s.r.o.
  - Nástupnická společnost: Kovotech Servis s.r.o.
  - Rozhodný den: 1. 1. 2026

3. ZAMĚSTNANCI
  - Na Kovotech Precision s.r.o. přejde 280 zaměstnanců (§ 338 a násl. zákoníku práce)
  - Odborová organizace bude informována a přechod s ní projednán nejméně 30 dnů předem

4. HARMONOGRAM
  - Schválení projektů představenstvem: září 2026
  - Valná hromada: 6. října 2026
  - Zápis do obchodního rejstříku (Krajský soud v Brně): prosinec 2026

Zpracovala: Hartvich & Partneři, advokátní kancelář, s.r.o.
Datum: 4. září 2026`,

  "Projekt_rozdeleni_odstepenim.pdf": `PROJEKT ROZDĚLENÍ ODŠTĚPENÍM SE VZNIKEM NOVÉ SPOLEČNOSTI

podle § 243 odst. 1 písm. b) bodu 1 zákona č. 125/2008 Sb., o přeměnách obchodních společností a družstev

Rozdělovaná společnost: Kovotech Vysočina a.s., IČO: 25319845, se sídlem Brněnská 5221/48, 586 01 Jihlava
Nástupnická společnost: Kovotech Precision s.r.o. (nově vznikající), se sídlem tamtéž

1. ODŠTĚPOVANÁ ČÁST JMĚNÍ
  - Výrobní hala Jihlava – Pávov (LV 3812, k. ú. Pávov)
  - Obráběcí centra a strojní vybavení podle přílohy č. 1 (účetní hodnota 148 000 000 Kč)
  - Zásoby materiálu a nedokončená výroba (účetní hodnota 37 000 000 Kč)
  - Pohledávky z obchodního styku divize přesného obrábění (52 000 000 Kč)

2. PŘECHÁZEJÍCÍ DLUHY
  - Dluhy vůči dodavatelům materiálu divize (21 000 000 Kč)
  - Práva a povinnosti z pracovněprávních vztahů 280 zaměstnanců

3. ZÁKLADNÍ KAPITÁL NÁSTUPNICKÉ SPOLEČNOSTI
  - 50 000 000 Kč
  - Jediný společník: Kovotech Vysočina a.s.

4. ROZHODNÝ DEN: 1. ledna 2026

5. ZNALECKÝ POSUDEK
Odštěpované jmění ocenil znalec Ing. Martin Holub, Ph.D., posudkem č. 77-9/2026 na 216 000 000 Kč.

V Jihlavě dne 18. září 2026`,

  "Zapis_z_valne_hromady.docx": `NOTÁŘSKÝ ZÁPIS
o rozhodnutí řádné valné hromady
Kovotech Vysočina a.s.

Datum: 6. října 2026, 10:00
Místo: Jihlava, Brněnská 5221/48, zasedací místnost
Přítomni: akcionáři vlastnící akcie, jejichž jmenovitá hodnota představuje 91,4 % základního kapitálu; valná hromada je usnášeníschopná

Program:
1. Zahájení, volba orgánů valné hromady
2. Schválení projektu rozdělení odštěpením se vznikem nové společnosti
3. Schválení projektu fúze sloučením dceřiných společností
4. Změna stanov
5. Závěr

Usnesení č. 1: Valná hromada schvaluje projekt rozdělení odštěpením se vznikem nové společnosti Kovotech Precision s.r.o. ze dne 18. 9. 2026.
Hlasování: pro 88,9 %, proti 2,5 %, zdržel se 0 %

Usnesení č. 2: Valná hromada bere na vědomí projekt fúze sloučením společností Kovotech Nástroje s.r.o. a Kovotech Servis s.r.o.
Hlasování: pro 91,4 %, proti 0 %, zdržel se 0 %

Usnesení č. 3: Valná hromada schvaluje změnu stanov v rozsahu přílohy č. 2.
Hlasování: pro 91,4 %, proti 0 %, zdržel se 0 %

Notářský zápis sepsala: Mgr. Jana Křížová, notářka v Jihlavě
Číslo: NZ 214/2026`,

  "Schema_holdingove_struktury.pdf": `SCHÉMA HOLDINGOVÉ STRUKTURY – PO REORGANIZACI

Kovotech Vysočina a.s. (mateřská společnost, Jihlava)
  │
  ├── 100% Kovotech Precision s.r.o.
  │     (přesné obrábění, 280 zaměstnanců)
  │
  ├── 100% Kovotech Servis s.r.o.
  │     (servis, údržba a nástrojárna, 64 zaměstnanců)
  │
  └── 60% Kovotech Slovakia, s.r.o.
        (obchodní zastoupení pro Slovensko, 15 zaměstnanců)

Vstup strategického investora do Kovotech Precision s.r.o.:
  - Podíl investora: 49 % po navýšení základního kapitálu
  - Investice: 180 000 000 Kč
  - Podmínka: zachování zaměstnanosti v Jihlavě nejméně 3 roky

Časový plán:
  Q4 2026: zápis rozdělení a fúze do obchodního rejstříku
  Q1 2027: vstup investora
  Q2 2027: refinancování skupinového úvěru`,

  // ws-cross-border
  "Term_sheet_Projekt_Dunaj.pdf": `TERM SHEET – PŘESHRANIČNÍ AKVIZICE
Projekt Dunaj
Datum: 12. 3. 2026

Kupující: Zelený horizont investiční fond, SICAV, a.s. (Česká republika)
Cílová společnost: Donauwerk Wassertechnik GmbH (Linec, Rakousko), včetně dceřiné společnosti Donauwerk CZ s.r.o. (České Budějovice)
Prodávající: Altmühl Beteiligungs GmbH (Mnichov, Německo)

1. STRUKTURA TRANSAKCE
   Forma: koupě 100% obchodního podílu (share deal)
   Hodnota podniku: 42 000 000 EUR
   Úpravy: čistý dluh a pracovní kapitál (cílová hodnota 5 100 000 EUR)

2. HLAVNÍ PODMÍNKY
   Exkluzivita: 60 dnů od podpisu term sheetu
   Odstupné při nedokončení: 600 000 EUR (oboustranné)
   Rozhodné právo: rakouské (převod podílu formou notářského zápisu)
   Rozhodčí řízení: VIAC Vídeň

3. ODKLÁDACÍ PODMÍNKY
   a) Uspokojivé výsledky právní, finanční a daňové prověrky
   b) Povolení spojení rakouským soutěžním úřadem (BWB)
   c) Prověrka zahraniční investice podle rakouského InvKG (vodárenská infrastruktura)
   d) Souhlas klíčových odběratelů (více než 50 % tržeb)
   e) Nenastání podstatné nepříznivé změny

4. ORIENTAČNÍ HARMONOGRAM
   Dokončení prověrky: 15. 5. 2026
   Podpis kupní smlouvy: 30. 6. 2026
   Regulatorní povolení: 30. 9. 2026
   Vypořádání: 31. 10. 2026

5. ZAMĚSTNANCI
   Udržení klíčového managementu: 24 měsíců
   Bez propouštění 12 měsíců po vypořádání

Term sheet je nezávazný s výjimkou ustanovení o exkluzivitě a odstupném.`,

  "Regulatorni_analyza_spojeni.pdf": `REGULATORNÍ ANALÝZA SPOJENÍ – PROJEKT DUNAJ

1. ÚČASTNÍCI
   Nabyvatel: Zelený horizont investiční fond, SICAV, a.s.
   - Sídlo: Praha, Česká republika
   - Obrat portfoliových společností (2025): 9 400 000 000 Kč

   Cílová společnost: Donauwerk Wassertechnik GmbH
   - Sídlo: Linec, Rakousko
   - Obrat (2025): 38 000 000 EUR, z toho v ČR 11 000 000 EUR
   - Zaměstnanci: 165

2. RAKOUSKO
   a) Kontrola spojení (BWB): oznámení POVINNÉ, prahové hodnoty obratu splněny; lhůta první fáze 4 týdny
   b) Prověrka zahraničních investic (InvKG): oznámení POVINNÉ, cílová společnost dodává technologie pro vodárenskou infrastrukturu; nabyvatel je investor ze státu EU, prověrka se přesto vztahuje na nabytí nad 25 %

3. ČESKÁ REPUBLIKA
   a) Kontrola spojení (ÚOHS): oznámení POVINNÉ, obrat cílové společnosti v ČR přesahuje 250 000 000 Kč
   b) Prověrka zahraničních investic podle zákona č. 34/2021 Sb.: NEPOUŽIJE SE, nabyvatel je český investor

4. EVROPSKÁ UNIE
   Unijní rozměr podle nařízení o spojování podniků: NENÍ DÁN
   Nařízení o zahraničních subvencích: NEPOUŽIJE SE

5. ZÁVĚR
   Podat oznámení BWB a ÚOHS souběžně nejpozději 10. 7. 2026; prověrku podle InvKG zahájit ihned po podpisu.

Zpracovala: Hartvich & Partneři, advokátní kancelář, s.r.o.
Datum: 7. dubna 2026`,

  "Navrh_kupni_smlouvy_Dunaj.docx": `SMLOUVA O KOUPI OBCHODNÍHO PODÍLU – NÁVRH v2.1
Projekt Dunaj

SMLUVNÍ STRANY:
(1) Zelený horizont investiční fond, SICAV, a.s., Praha („Kupující“)
(2) Altmühl Beteiligungs GmbH, HRB 248317, Mnichov („Prodávající“)
(3) Donauwerk Wassertechnik GmbH, FN 512734 k, Linec („Společnost“)

PREAMBULE:
(A) Prodávající je jediným společníkem Společnosti.
(B) Kupující hodlá nabýt 100% obchodní podíl ve Společnosti.
(C) Smluvní strany se dohodly na podmínkách uvedených níže.

ČLÁNEK 1 – PŘEVOD PODÍLU
1.1 Prodávající prodává a Kupující kupuje celý obchodní podíl ve Společnosti.
1.2 Podíl se převádí prostý jakýchkoli zatížení.
1.3 Převod podílu bude proveden formou rakouského notářského zápisu (Notariatsakt).

ČLÁNEK 2 – KUPNÍ CENA
2.1 Hodnota podniku: 42 000 000 EUR
2.2 Hodnota vlastního kapitálu = hodnota podniku – čistý dluh + přebytek pracovního kapitálu
2.3 Odhad hodnoty vlastního kapitálu k podpisu: 37 400 000 EUR
2.4 Účetní závěrka k vypořádání bude sestavena do 60 dnů od vypořádání.

ČLÁNEK 3 – ZÁRUKY PRODÁVAJÍCÍHO
3.1 Prodávající poskytuje záruky uvedené v příloze č. 3.
3.2 Limit odpovědnosti: 30 % kupní ceny (11 220 000 EUR)
3.3 Minimální výše jednotlivého nároku: 50 000 EUR
3.4 Souhrnný práh (basket): 250 000 EUR
3.5 Záruční doba: 24 měsíců od vypořádání (daňové záruky 60 měsíců)

[PŘÍLOHY BUDOU DOPLNĚNY]`,

  "Analyza_soutezniho_prava.pdf": `ANALÝZA SOUTĚŽNÍHO PRÁVA
Projekt Dunaj – Zelený horizont / Donauwerk

1. VYMEZENÍ TRHU
   Věcně relevantní trh: průmyslové systémy úpravy vody
   Geograficky relevantní trh: Rakousko a Česká republika (národní trhy)

2. TRŽNÍ PODÍLY (2025, Česká republika)
   Soutěžitel                         | Podíl
   Donauwerk CZ (cílová společnost)   | 9 %
   Portfoliové společnosti fondu      | 4 %
   Tři největší konkurenti celkem     | 47 %
   Ostatní                            | 40 %

   Společný podíl po spojení: cca 13 % → bez rizika dominance

3. HORIZONTÁLNÍ PŘEKRYV
   Obě strany působí v úpravě průmyslové vody.
   Společný podíl ve všech segmentech nižší než 25 %.
   Vstup na trh bez významných bariér (řada konkurentů z EU).

4. VERTIKÁLNÍ VZTAHY
   Portfoliová společnost fondu dodává membránové filtry, které Donauwerk CZ používá.
   Její podíl na dodávkách membrán v ČR: méně než 8 %.
   Riziko uzavření trhu nebylo zjištěno.

5. ZÁVĚR
   Očekáváme povolení v prvním stupni řízení bez závazků.
   Správní poplatek ÚOHS: 100 000 Kč

   Doporučené podání: 10. 7. 2026
   Očekávané rozhodnutí: srpen 2026

Zpracovala: Hartvich & Partneři, advokátní kancelář, s.r.o.`,

  // ws-gdpr-audit
  "Analyza_souladu_GDPR.pdf": `ANALÝZA SOULADU S GDPR
Klient: Brněnská stavební společnost, s.r.o.

Datum posouzení: březen 2026
Zpracovala: Hartvich & Partneři, advokátní kancelář, s.r.o.

1. SHRNUTÍ
   Současná úroveň souladu: 62 % (cíl: 95 %)
   Kritické nedostatky: 4
   Nedostatky vysoké priority: 6
   Nedostatky střední priority: 5

2. KRITICKÉ NEDOSTATKY
   2.1 Biometrický docházkový systém (otisky prstů) bez posouzení vlivu a bez platného právního základu (čl. 9 GDPR)
   2.2 Kamerové systémy na staveništích snímají i veřejná prostranství a sousední pozemky
   2.3 Sledování služebních vozidel GPS i mimo pracovní dobu (§ 316 odst. 2 zákoníku práce)
   2.4 Chybí postup pro hlášení porušení zabezpečení ÚOOÚ do 72 hodin (čl. 33 GDPR)

3. NEDOSTATKY VYSOKÉ PRIORITY
   3.1 Informace pro zaměstnance neuvádějí doby uložení ani právní základy
   3.2 Chybí smlouvy o zpracování se 3 z 8 zpracovatelů
   3.3 Záznamy o činnostech zpracování jsou neúplné (čl. 30 GDPR)
   3.4 Osobní údaje zaměstnanců subdodavatelů se předávají bez smluvního základu
   3.5 Školení zaměstnanců neproběhlo posledních 12 měsíců
   3.6 Žádosti o výmaz se nevyřizují podle písemného postupu

4. HARMONOGRAM NÁPRAVY
   Kritické: 30 dnů
   Vysoká priorita: 90 dnů
   Střední priorita: 180 dnů

   Odhad celkových nákladů: 1 100 000–1 600 000 Kč`,

  "Smlouva_o_zpracovani_osobnich_udaju.pdf": `SMLOUVA O ZPRACOVÁNÍ OSOBNÍCH ÚDAJŮ
podle čl. 28 nařízení (EU) 2016/679 (GDPR)

Správce: Brněnská stavební společnost, s.r.o., IČO: 46972315, se sídlem Heršpická 813/5, 639 00 Brno
Zpracovatel: Evidio Systems s.r.o., IČO: 07215394, se sídlem Holandská 878/2, 639 00 Brno

1. PŘEDMĚT A ROZSAH ZPRACOVÁNÍ
   Kategorie osobních údajů: identifikační údaje, údaje o docházce, záznamy o vstupu na staveniště
   Subjekty údajů: zaměstnanci správce a pracovníci subdodavatelů
   Účel: evidence pracovní doby, řízení vstupu na staveniště, mzdové podklady

2. POVINNOSTI ZPRACOVATELE
   2.1 Zpracovávat údaje pouze na základě doložených pokynů správce
   2.2 Zajistit mlčenlivost všech osob, které s údaji pracují
   2.3 Šifrování dat v klidu (AES-256) i při přenosu (TLS 1.3)
   2.4 Poskytovat součinnost při posouzení vlivu a vyřizování žádostí subjektů údajů
   2.5 Do 30 dnů od skončení smlouvy všechny údaje vymazat nebo vrátit

3. DALŠÍ ZPRACOVATELÉ
   Schválení další zpracovatelé:
   a) poskytovatel cloudové infrastruktury (datové centrum ve Frankfurtu nad Mohanem)
   b) poskytovatel monitoringu provozu (EU)
   Změnu dalšího zpracovatele oznámí zpracovatel správci nejméně 30 dnů předem.

4. PŘEDÁVÁNÍ DO TŘETÍCH ZEMÍ
   Bez předchozího písemného souhlasu správce se osobní údaje mimo EHP nepředávají.

5. AUDIT
   Správce je oprávněn provést audit jednou ročně s oznámením 30 dnů předem.

Účinnost: 1. 4. 2026`,

  "Posouzeni_vlivu_DPIA.docx": `POSOUZENÍ VLIVU NA OCHRANU OSOBNÍCH ÚDAJŮ (DPIA)
Brněnská stavební společnost, s.r.o. – docházka a kamerové systémy na staveništích

1. POPIS ZPRACOVÁNÍ
   Docházkové terminály na 11 staveništích zaznamenávají příchody a odchody přibližně 640 osob (zaměstnanci i pracovníci subdodavatelů). Staveniště jsou střežena kamerovým systémem se záznamem.
   Doba uložení: docházka 3 roky, kamerové záznamy 7 dnů

2. NEZBYTNOST A PŘIMĚŘENOST
   Právní základ docházky: plnění právní povinnosti (evidence pracovní doby, čl. 6 odst. 1 písm. c) GDPR)
   Právní základ kamer: oprávněný zájem na ochraně majetku (čl. 6 odst. 1 písm. f) GDPR)
   Biometrické údaje: pro evidenci docházky nejsou nezbytné, souhlas zaměstnance není svobodný

3. RIZIKA PRO SUBJEKTY ÚDAJŮ
   3.1 VYSOKÉ: zneužití otisků prstů při úniku databáze (údaje nelze změnit)
   3.2 VYSOKÉ: soustavné sledování zaměstnanců kamerami v zázemí staveniště
   3.3 STŘEDNÍ: snímání veřejných prostranství a sousedních pozemků
   3.4 NÍZKÉ: neoprávněný přístup subdodavatelů k docházkovým datům

4. OPATŘENÍ
   3.1 → nahradit otisky prstů čipovými kartami a biometrická data vymazat do 30 dnů
   3.2 → vyloučit ze záběru šatny, jídelny a kanceláře stavbyvedoucích
   3.3 → nastavit maskování záběru mimo hranice staveniště
   3.4 → přístupová práva podle rolí a záznam o přístupech

5. ZÁVĚR
   Po přijetí opatření je zbytkové riziko přijatelné; předchozí konzultace s ÚOOÚ není nutná.

Zpracovala: Mgr. Klára Nováková, Hartvich & Partneři
Datum: 20. března 2026`,

  "Zasady_ochrany_osobnich_udaju.pdf": `ZÁSADY OCHRANY OSOBNÍCH ÚDAJŮ
Brněnská stavební společnost, s.r.o.
Informace pro zaměstnance a pracovníky subdodavatelů

Účinnost: 1. května 2026

1. SPRÁVCE
   Brněnská stavební společnost, s.r.o., IČO: 46972315, Heršpická 813/5, 639 00 Brno

2. JAKÉ ÚDAJE ZPRACOVÁVÁME
   a) Identifikační a kontaktní údaje: jméno, příjmení, datum narození, adresa
   b) Údaje o docházce: čas příchodu a odchodu, číslo čipové karty
   c) Kamerové záznamy ze staveniště (uchovávány 7 dnů)
   d) Údaje o poloze služebních vozidel, pouze v pracovní době

3. PROČ ÚDAJE ZPRACOVÁVÁME
   - Plnění povinností podle zákoníku práce a předpisů o bezpečnosti práce
   - Ochrana majetku na staveništích (oprávněný zájem)
   - Mzdové a personální agendy

4. VAŠE PRÁVA
   Máte právo na přístup, opravu, výmaz, omezení zpracování, přenositelnost a vznést námitku. Stížnost můžete podat u Úřadu pro ochranu osobních údajů (www.uoou.cz).

5. ZÁKONNÝ RÁMEC
   Nařízení (EU) 2016/679 (GDPR) a zákon č. 110/2019 Sb., o zpracování osobních údajů.

6. KONTAKT
   Pověřenec pro ochranu osobních údajů: Mgr. Klára Nováková
   E-mail: gdpr@brnenska-stavebni.example`,
};
