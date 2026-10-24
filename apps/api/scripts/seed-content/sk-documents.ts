// The Slovak firm's documents (Hrabovský & Partneri, Bratislava): file names,
// the three Meridian closing e-mails and the extracted text of every seeded
// document, written under Slovak law for the sk marketing captures. The
// supplier agreement's text comes from its tracked-change paragraphs instead.
import { MARKETING_LOCALE_MARKERS } from "@stll/playwright-tools/marketing-locales";

import type { SeedEmail, StandardMatterLabel } from "./types";

export const SK_SPA_DOCUMENT_NAME = "Zmluva_o_prevode_obchodneho_podielu.pdf";

const SK_EMAIL_FILE_NAMES = [
  "Zajtra_podpis_zaverecny_checklist.eml",
  "Fwd_URSO_podmienka_c_7.eml",
  "Informacia_pre_klienta_Zilina.eml",
] as const;

type SkEmailFileName = (typeof SK_EMAIL_FILE_NAMES)[number];

export const SK_EMAILS = {
  "Zajtra_podpis_zaverecny_checklist.eml": {
    from: "Zuzana Kováčiková <zuzana.kovacikova@severka.example>",
    to: [
      "Martin Šoltés <martin.soltes@severka.example>",
      "Peter Mráz <peter.mraz@hronska-energetika.example>",
    ],
    cc: [
      "Klaudia Novotná <klaudia.novotna@hrabovsky.example>",
      "Tím pre closing <closing@severka.example>",
    ],
    date: "Thu, 16 Jul 2026 17:42:00 +0200",
    subject: "Zajtra podpis: záverečný checklist a tok platieb",
    textBody: `Dobrý deň všetkým,

zajtra o 9:00 podpisujeme v notárskej kancelárii v Žiline. Priložený tok platieb považujte za finálny, pokiaľ Klaudia do 8:30 nerozošle novú verziu.

Zádržné vo výške 600 000 eur sa z notárskej úschovy neuvoľní, kým nebudú písomne potvrdené obe podpisové strany a splnenie podmienky č. 7 z rozhodnutia ÚRSO.

Posledné úlohy:
1. Peter: do 8:15 doručiť rozhodnutie jediného spoločníka o súhlase s prevodom podielu.
2. Martin: potvrdiť odosielací účet končiaci číslom 2048.
3. Klaudia: po kontrole všetkých podpisov odoslať e-mail o dokončení transakcie.

Ak sa niečo v noci zmení, odpovedzte, prosím, do tohto vlákna a nezakladajte nové.

S pozdravom
Zuzana`,
    htmlBody: `<p>Dobrý deň všetkým,</p>
<p>zajtra o <strong>9:00</strong> podpisujeme v notárskej kancelárii v Žiline. Priložený tok platieb považujte za finálny, pokiaľ Klaudia do 8:30 nerozošle novú verziu.</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0">
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Podpis</strong></td><td style="border:1px solid #d1d5db;padding:8px">17. 7. 2026, 9:00, notárska kancelária Žilina</td></tr>
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Zádržné</strong></td><td style="border:1px solid #d1d5db;padding:8px">600 000 eur v notárskej úschove</td></tr>
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Podmienka uvoľnenia</strong></td><td style="border:1px solid #d1d5db;padding:8px">Podpisy + splnenie podmienky č. 7 ÚRSO</td></tr>
</table>
<p><strong>Zádržné vo výške 600 000 eur sa z notárskej úschovy neuvoľní, kým nebudú písomne potvrdené obe podpisové strany a splnenie podmienky č. 7 z rozhodnutia ÚRSO.</strong></p>
<p>Posledné úlohy:</p>
<ol>
  <li>Peter: do 8:15 doručiť rozhodnutie jediného spoločníka o súhlase s prevodom podielu.</li>
  <li>Martin: potvrdiť odosielací účet končiaci číslom 2048.</li>
  <li>Klaudia: po kontrole všetkých podpisov odoslať e-mail o dokončení transakcie.</li>
</ol>
<p>Ak sa niečo v noci zmení, odpovedzte, prosím, do tohto vlákna a nezakladajte nové.</p>
<p>S pozdravom<br>Zuzana</p>`,
    attachments: [
      {
        type: "pdf",
        fileName: "Finalny_tok_platieb.pdf",
        title: "Finálny tok platieb",
        bodyText:
          "Tok platieb pri closingu Energopark Žilina, s.r.o. Zádržné: 600 000 eur v notárskej úschove. Uvoľniť až po potvrdení podpísaných strán a splnení podmienky č. 7 ÚRSO právnou zástupkyňou pre closing.",
      },
      {
        type: "text",
        fileName: "Kontakty_closing.txt",
        bodyText:
          "Právna zástupkyňa pre closing: Mgr. Klaudia Novotná\nNotárska úschova: +421 41 555 0204\nKonferenčný hovor k dokončeniu: 8:45",
      },
    ],
  },
  "Fwd_URSO_podmienka_c_7.eml": {
    from: "Klaudia Novotná <klaudia.novotna@hrabovsky.example>",
    to: ["Zuzana Kováčiková <zuzana.kovacikova@severka.example>"],
    cc: ["Transakčný tím <transakcie@severka.example>"],
    date: "Wed, 15 Jul 2026 14:18:00 +0200",
    subject: "Fwd: Rozhodnutie ÚRSO doručené — podmienka č. 7 zostáva otvorená",
    textBody: `Zuzana,

ÚRSO vydalo rozhodnutie. Podmienka č. 7 je naďalej otvorená, pretože úrad požaduje aktualizovaný harmonogram pripojenia odberných miest najneskôr do 20. 7. 2026. Súhlas PMÚ SR s koncentráciou máme od 10. 7. 2026, iné regulačné podmienky už otvorené nie sú.

Odporúčam: ku closingu môžeme pristúpiť, len ak predávajúci podpíše priložený záväzok a suma 600 000 eur zostane v notárskej úschove.

---------- Preposlaná správa ---------
Od: Podateľňa ÚRSO <podatelna@urso.example>
Dátum: st 15. 7. 2026 o 13:52
Predmet: Rozhodnutie č. 0412/2026/E
Komu: Klaudia Novotná <klaudia.novotna@hrabovsky.example>

Úrad pre reguláciu sieťových odvetví vydáva súhlas s podmienkou č. 7. Žiadateľ predloží aktualizovaný harmonogram pripojenia odberných miest najneskôr do 20. 7. 2026.

Klaudia`,
    htmlBody: `<p>Zuzana,</p>
<p>ÚRSO vydalo rozhodnutie. <strong>Podmienka č. 7 je naďalej otvorená</strong>, pretože úrad požaduje aktualizovaný harmonogram pripojenia odberných miest najneskôr do 20. 7. 2026. Súhlas PMÚ SR s koncentráciou máme od 10. 7. 2026, iné regulačné podmienky už otvorené nie sú.</p>
<p>Odporúčam: ku closingu môžeme pristúpiť, len ak predávajúci podpíše priložený záväzok a suma 600 000 eur zostane v notárskej úschove.</p>
<div class="gmail_quote" style="border-left:3px solid #d1d5db;margin:20px 0;padding-left:16px;color:#4b5563">
  <div>---------- Preposlaná správa ---------</div>
  <div><strong>Od:</strong> Podateľňa ÚRSO &lt;podatelna@urso.example&gt;</div>
  <div><strong>Dátum:</strong> st 15. 7. 2026 o 13:52</div>
  <div><strong>Predmet:</strong> Rozhodnutie č. 0412/2026/E</div>
  <div><strong>Komu:</strong> Klaudia Novotná &lt;klaudia.novotna@hrabovsky.example&gt;</div>
  <p>Úrad pre reguláciu sieťových odvetví vydáva súhlas s podmienkou č. 7. Žiadateľ predloží aktualizovaný harmonogram pripojenia odberných miest najneskôr do 20. 7. 2026.</p>
</div>
<p>Klaudia</p>`,
    attachments: [
      {
        type: "pdf",
        fileName: "Zavazok_predavajuceho_podmienka_7.pdf",
        title: "Záväzok predávajúceho — podmienka č. 7",
        bodyText:
          "Predávajúci sa zaväzuje predložiť ÚRSO aktualizovaný harmonogram pripojenia odberných miest do 20. 7. 2026 a súhlasí, aby suma 600 000 eur zostala v notárskej úschove až do písomného potvrdenia.",
      },
    ],
  },
  "Informacia_pre_klienta_Zilina.eml": {
    from: "Alena Hudecová <alena.hudecova@hrabovsky.example>",
    to: [
      "Martin Šoltés <martin.soltes@severka.example>",
      "Zuzana Kováčiková <zuzana.kovacikova@severka.example>",
    ],
    cc: [],
    date: "Tue, 14 Jul 2026 11:06:00 +0200",
    subject: "Informácia pre klienta: podpis v Žiline / Kurzinfo für Meridian",
    textBody: `Dobrý deň, pán Šoltés, pani Kováčiková,

podpis zmluvy o prevode obchodného podielu v spoločnosti Energopark Žilina, s.r.o. zostáva naplánovaný na 17. 7. 2026. Ďalšie korporátne schválenia nie sú potrebné: dozorná rada udelila súhlas 14. 7. a predstavenstvo rozhodne 15. 7. 2026.

Zmluva o dodávkach s Meridian: kolegyňa Klaudia Novotná zaslala protistrane revidovaný návrh. Otvorené zostávajú dva body, limit zodpovednosti a doložka o zmene kontroly. Rokovanie s pani Vogel máme dohodnuté na 21. 7. 2026.

Nižšie je krátke zhrnutie v nemčine, ktoré môžete preposlať pani Vogel.

Deutsch: Die Unterzeichnung in Žilina bleibt für den 17. Juli 2026 geplant. Der Erwerb der Energopark Žilina, s.r.o. berührt den Liefervertrag mit Meridian nicht; offen sind nur die Haftungsgrenze und die Change-of-Control-Klausel.

S pozdravom
Alena Hudecová`,
    htmlBody: `<p>Dobrý deň, pán Šoltés, pani Kováčiková,</p>
<p>podpis zmluvy o prevode obchodného podielu v spoločnosti Energopark Žilina, s.r.o. zostáva naplánovaný na <strong>17. 7. 2026</strong>. Ďalšie korporátne schválenia nie sú potrebné: dozorná rada udelila súhlas 14. 7. a predstavenstvo rozhodne 15. 7. 2026.</p>
<p><strong>Zmluva o dodávkach s Meridian:</strong> kolegyňa Klaudia Novotná zaslala protistrane revidovaný návrh. Otvorené zostávajú dva body, limit zodpovednosti a doložka o zmene kontroly. Rokovanie s pani Vogel máme dohodnuté na 21. 7. 2026.</p>
<p>Nižšie je krátke zhrnutie v nemčine, ktoré môžete preposlať pani Vogel.</p>
<p lang="de"><strong>Deutsch:</strong> Die Unterzeichnung in Žilina bleibt für den 17. Juli 2026 geplant. Der Erwerb der Energopark Žilina, s.r.o. berührt den Liefervertrag mit Meridian nicht; offen sind nur die Haftungsgrenze und die Change-of-Control-Klausel.</p>
<p>S pozdravom<br>Alena Hudecová</p>`,
    attachments: [],
  },
} as const satisfies Record<SkEmailFileName, SeedEmail>;

export const SK_MATTER_DOCUMENTS = {
  "ws-akvizice-energo": [
    SK_SPA_DOCUMENT_NAME,
    "Sprava_o_pravnej_preverke.pdf",
    "Rozhodnutie_predstavenstva_Severka.docx",
    "Znalecky_posudok_ocenenie_podielu.pdf",
    MARKETING_LOCALE_MARKERS.sk.safeAgreementFileName,
    MARKETING_LOCALE_MARKERS.sk.redactedExtractFileName,
    MARKETING_LOCALE_MARKERS.sk.supplierAgreementFileName,
    ...SK_EMAIL_FILE_NAMES,
  ],
  "ws-stavebni-spor": [
    "Zaloba_o_nahradu_skody.pdf",
    "Znalecky_posudok_stavba.pdf",
    "Zapisnica_z_obhliadky_stavby.docx",
    "Doplnenie_dokaznych_navrhov.pdf",
  ],
  "ws-due-diligence": [
    "Kontrolny_zoznam_DD.pdf",
    "Struktura_skupiny_Vertiq.pdf",
    "Navrh_zmluvy_o_prevode_podielu_v3.docx",
    "Sprava_o_regulatornom_sulade.pdf",
  ],
  "ws-pracovni-spory": [
    "Vypoved_z_pracovneho_pomeru.pdf",
    "Zaloba_o_neplatnost_vypovede.pdf",
    "Pracovna_zmluva.docx",
    "Zapisnica_o_vypovedi_svedka.pdf",
  ],
  "ws-compliance-ceska-energie": [
    "Compliance_manual_2025.pdf",
    "Hodnotenie_korupcnych_rizik.pdf",
    "Sprava_z_interneho_auditu.docx",
    "Skolenie_compliance_2025.pdf",
  ],
  "ws-reorganizace": [
    "Reorganizacny_plan.pdf",
    "Zmluva_o_zluceni.pdf",
    "Zapisnica_z_valneho_zhromazdenia.docx",
    "Schema_holdingovej_struktury.pdf",
  ],
  "ws-cross-border": [
    "Term_sheet_Projekt_Dunaj.pdf",
    "Oznamenie_koncentracie_PMU.pdf",
    "Navrh_zmluvy_o_kupe_podielu_Dunaj.docx",
    "Analyza_sutazneho_prava.pdf",
  ],
  "ws-gdpr-audit": [
    "Analyza_nedostatkov_GDPR.pdf",
    "Zmluva_o_spracuvani_osobnych_udajov.pdf",
    "Posudenie_vplyvu_DPIA.docx",
    "Zasady_cookies_navrh.pdf",
  ],
} satisfies Record<StandardMatterLabel, readonly string[]>;

/**
 * Extracted text for each document, keyed by file name so the same text is
 * reused when document names cycle across extra matters.
 */
export const SK_DOCUMENT_TEXTS: Record<string, string> = {
  // ws-akvizice-energo
  [SK_SPA_DOCUMENT_NAME]: `ZMLUVA O PREVODE OBCHODNÉHO PODIELU
uzavretá podľa § 115 a nasl. zákona č. 513/1991 Zb. Obchodný zákonník v znení neskorších predpisov

Zmluvné strany:
1. Prevodca: Hronská energetika, a.s., IČO: 36785412, so sídlom Mlynské nivy 48, 821 09 Bratislava, zapísaná v obchodnom registri Mestského súdu Bratislava III, oddiel: Sa, vložka č. 6247/B, konajúca Ing. Petrom Mrázom, predsedom predstavenstva (ďalej len „Prevodca“)
2. Nadobúdateľ: Severka Robotics, a.s., IČO: 51284736, so sídlom Kamenná 14, 010 01 Žilina, zapísaná v obchodnom registri Okresného súdu Žilina, oddiel: Sa, vložka č. 11284/L, konajúca Ing. Martinom Šoltésom, predsedom predstavenstva (ďalej len „Nadobúdateľ“)

Článok I – Predmet zmluvy
1.1 Prevodca je jediným spoločníkom spoločnosti Energopark Žilina, s.r.o., IČO: 47358126, so sídlom Priemyselná 9, 010 01 Žilina, zapísanej v obchodnom registri Okresného súdu Žilina, oddiel: Sro, vložka č. 61523/L (ďalej len „Spoločnosť“).
1.2 Prevodca prevádza na Nadobúdateľa obchodný podiel zodpovedajúci vkladu 1 200 000 eur, ktorý predstavuje 100 % podiel na základnom imaní Spoločnosti (ďalej len „Obchodný podiel“), a Nadobúdateľ Obchodný podiel prijíma.
1.3 Nadobúdateľ vyhlasuje, že pristupuje k spoločenskej zmluve Spoločnosti v znení jej neskorších zmien.

Článok II – Kúpna cena
2.1 Kúpna cena za Obchodný podiel je 4 850 000 eur (slovom: štyri milióny osemstopäťdesiattisíc eur).
2.2 Nadobúdateľ uhradí kúpnu cenu takto:
  a) 2 000 000 eur do 10 pracovných dní odo dňa podpisu tejto zmluvy;
  b) 2 250 000 eur do 30 dní po splnení odkladacích podmienok podľa článku IV;
  c) 600 000 eur zložením do notárskej úschovy ako zádržné, ktoré sa uvoľní do 90 dní od zápisu Nadobúdateľa do obchodného registra.

Článok III – Vyhlásenia a záruky
3.1 Prevodca vyhlasuje a zaručuje, že:
  a) Obchodný podiel je plne splatený a nie je zaťažený záložným právom ani iným právom tretej osoby;
  b) Spoločnosť je držiteľom platného povolenia na podnikanie v energetike na distribúciu elektriny v miestnej distribučnej sústave;
  c) Spoločnosť nemá splatné záväzky presahujúce 200 000 eur a nie je účastníkom súdnych sporov s hodnotou predmetu sporu nad 80 000 eur.

Článok IV – Odkladacie podmienky
4.1 Účinnosť prevodu Obchodného podielu je podmienená:
  a) súhlasom Protimonopolného úradu SR s koncentráciou podľa zákona č. 187/2021 Z. z. o ochrane hospodárskej súťaže;
  b) splnením podmienky č. 7 rozhodnutia Úradu pre reguláciu sieťových odvetví (ÚRSO);
  c) tým, že do dňa dokončenia nenastane podstatná nepriaznivá zmena (Material Adverse Change).

Článok V – Záverečné ustanovenia
5.1 Prevod Obchodného podielu je voči Spoločnosti účinný jej doručením tejto zmluvy; Nadobúdateľ podá návrh na zápis zmeny do obchodného registra do 30 dní od účinnosti prevodu.
5.2 Táto zmluva sa spravuje právom Slovenskej republiky. Podpisy zmluvných strán musia byť úradne osvedčené.

V Žiline dňa 17. 7. 2026`,

  "Sprava_o_pravnej_preverke.pdf": `SPRÁVA O PRÁVNEJ PREVERKE (DUE DILIGENCE)
Cieľová spoločnosť: Energopark Žilina, s.r.o.

1. ZHRNUTIE
Právna preverka prebehla v období od 4. 5. do 29. 5. 2026. Preverili sme 286 dokumentov z dátovej miestnosti predávajúceho. Celkové riziko hodnotíme ako STREDNÉ.

2. KORPORÁTNA ŠTRUKTÚRA
- Základné imanie: 1 200 000 eur, plne splatené
- Jediný spoločník: Hronská energetika, a.s.
- Konateľ: Ing. Roman Kubiš
- Prokurista: Ing. Jana Vlčková, prokúra udelená do 12/2026

3. IDENTIFIKOVANÉ RIZIKÁ
3.1 Vysoké riziká:
  - Po zmene spoločníka treba ÚRSO oznámiť zmenu údajov k povoleniu na podnikanie v energetike; rozhodnutie ÚRSO bude obsahovať podmienky
  - Prebiehajúce správne konanie ÚRSO o pokute 45 000 eur za porušenie pravidiel trhu s elektrinou

3.2 Stredné riziká:
  - Zmluva o pripojení do regionálnej distribučnej sústavy obsahuje doložku o zmene kontroly
  - 1 pracovnoprávny spor (expozícia približne 38 000 eur)
  - Nájomná zmluva k pozemkom pod transformovňou 110/22 kV končí 12/2027 bez opcie na predĺženie
  - Záložné právo k transformovni v prospech úverujúcej banky

3.3 Nízke riziká:
  - Nesúlad zápisu v katastri nehnuteľností (LV č. 4127, k. ú. Bytčica)
  - Chýbajúce záznamy o spracovateľských činnostiach pri 2 dodávateľoch

4. ODPORÚČANIA
  a) Zaviazať predávajúceho, aby pred dokončením transakcie splnil podmienky rozhodnutia ÚRSO
  b) Požadovať osobitné odškodnenie za konanie ÚRSO o pokute
  c) Zaradiť zmluvu o pripojení a nájomnú zmluvu do zoznamu zmlúv vyžadujúcich súhlas so zmenou kontroly

Vypracovala: Hrabovský & Partneri, advokátska kancelária, s.r.o.
Dátum: 29. 5. 2026`,

  "Rozhodnutie_predstavenstva_Severka.docx": `SEVERKA ROBOTICS, A.S.
Kamenná 14, 010 01 Žilina, IČO: 51284736

ROZHODNUTIE PREDSTAVENSTVA PRIJATÉ MIMO ZASADNUTIA (PER ROLLAM)

Predstavenstvo spoločnosti Severka Robotics, a.s., s predchádzajúcim súhlasom dozornej rady udeleným dňa 14. 7. 2026, jednomyseľne:

1. schvaľuje nadobudnutie 100 % obchodného podielu v spoločnosti Energopark Žilina, s.r.o. za kúpnu cenu 4 850 000 eur za podmienok návrhu zmluvy o prevode obchodného podielu predloženého predstavenstvu dňa 10. 7. 2026;

2. schvaľuje uzavretie zmluvy o budúcom podiele (SAFE) so spoločnosťou Tatra Horizon Capital, a.s. na investíciu vo výške 1 500 000 eur pri limite ocenenia 24 000 000 eur po investícii a zľave 20 %;

3. berie na vedomie, že vydanie nových akcií investorovi podlieha rozhodnutiu valného zhromaždenia o zvýšení základného imania podľa § 202 Obchodného zákonníka, a ukladá predsedovi predstavenstva pripraviť návrh tohto rozhodnutia;

4. poveruje predsedu predstavenstva podpísať obe zmluvy a urobiť všetky úkony potrebné na dokončenie transakcie a financovania.

Hlasovanie: za 3, proti 0, zdržal sa 0.

V Žiline dňa 15. 7. 2026

Ing. Martin Šoltés, predseda predstavenstva
Ing. Zuzana Kováčiková, členka predstavenstva
Mgr. Tomáš Ďurica, člen predstavenstva`,

  "Znalecky_posudok_ocenenie_podielu.pdf": `ZNALECKÝ POSUDOK č. 22/2026
Vo veci stanovenia všeobecnej hodnoty 100 % obchodného podielu v spoločnosti Energopark Žilina, s.r.o.

Znalec: Ing. Jozef Hlaváč, PhD., znalec zapísaný v zozname znalcov, tlmočníkov a prekladateľov vedenom Ministerstvom spravodlivosti SR
Odbor: Ekonómia a manažment, odvetvie: Oceňovanie podnikov, evidenčné číslo: 914387
Zadávateľ: Severka Robotics, a.s.
Rozhodujúci deň: 31. 5. 2026

ZÁVER:
Všeobecná hodnota 100 % obchodného podielu v spoločnosti Energopark Žilina, s.r.o. k rozhodujúcemu dňu je:

  4 640 000 eur až 5 100 000 eur

Stredná hodnota: 4 870 000 eur

Metóda ocenenia: postup podľa vyhlášky MS SR č. 492/2004 Z. z. o stanovení všeobecnej hodnoty majetku; kombinácia výnosovej metódy DCF (váha 70 %) a porovnávacej metódy (váha 30 %).

Kľúčové predpoklady:
- WACC: 7,9 %
- Terminálny rast: 2,0 %
- Plánovaná EBITDA 2026: 690 000 eur
- Plánovaná EBITDA 2027: 735 000 eur
- Regulované výnosy podľa platného cenového rozhodnutia ÚRSO
- Násobok EV/EBITDA porovnateľných spoločností: 6,5x – 7,2x

ZNALECKÁ DOLOŽKA
Znalecký úkon som vykonal ako znalec zapísaný v zozname znalcov, tlmočníkov a prekladateľov pod evidenčným číslom 914387. Som si vedomý následkov vedome nepravdivého znaleckého posudku.

V Žiline dňa 12. 6. 2026`,

  [MARKETING_LOCALE_MARKERS.sk.safeAgreementFileName]:
    `INTERNÝ NÁVRH — LEN NA PRIPOMIENKOVANIE

ZMLUVA O BUDÚCOM PODIELE (SAFE)
uzavretá podľa § 269 ods. 2 zákona č. 513/1991 Zb. Obchodný zákonník

Zmluvné strany:
1. Severka Robotics, a.s., IČO: 51284736, so sídlom Kamenná 14, 010 01 Žilina, konajúca Ing. Martinom Šoltésom, predsedom predstavenstva (ďalej len „Spoločnosť“)
2. Tatra Horizon Capital, a.s., IČO: 51936274, so sídlom Karadžičova 8, 821 08 Bratislava, konajúca Mgr. Andrejom Halásom, predsedom predstavenstva (ďalej len „Investor“)

PREAMBULA
Investor poskytne Spoločnosti sumu 1 500 000 eur (ďalej len „Investičná suma“) najneskôr do 31. 7. 2026. Spoločnosť sa za to zaväzuje vydať Investorovi akcie Spoločnosti za podmienok tejto zmluvy.

Článok 1 – Udalosti
1.1 Kolo financovania. Ak pred zánikom tejto zmluvy dôjde ku kolu financovania, Spoločnosť zabezpečí, aby valné zhromaždenie rozhodlo o zvýšení základného imania upísaním nových akcií s vylúčením prednostného práva akcionárov. Investor upíše počet akcií rovnajúci sa podielu Investičnej sumy a Konverznej ceny a emisný kurz splatí započítaním pohľadávky na vrátenie Investičnej sumy.
1.2 Udalosť likvidity. Ak pred zánikom tejto zmluvy dôjde k predaju podniku alebo k zmene kontroly nad Spoločnosťou, Investor má nárok na vyššiu z týchto súm:
  a) Investičnú sumu; alebo
  b) sumu pripadajúcu na počet akcií rovnajúci sa podielu Investičnej sumy a ceny pri udalosti likvidity.
1.3 Zrušenie Spoločnosti. Ak sa Spoločnosť zruší s likvidáciou pred zánikom tejto zmluvy, Investor má nárok na vrátenie Investičnej sumy prednostne pred akcionármi Spoločnosti.

Článok 2 – Vymedzenie pojmov
„Kapitalizácia Spoločnosti“ je celkový počet vydaných akcií Spoločnosti vrátane akcií z opčných programov, určený bezprostredne pred kolom financovania.
„Limit ocenenia“ je 24 000 000 eur po investícii (post-money).
„Zľava“ je 20 % z ceny akcie v kole financovania.

Článok 3 – Vyhlásenia Spoločnosti
Spoločnosť je riadne založená a zapísaná v obchodnom registri Okresného súdu Žilina, oddiel: Sa, vložka č. 11284/L. Uzavretie tejto zmluvy schválilo predstavenstvo s predchádzajúcim súhlasom dozornej rady.

Článok 4 – Vyhlásenia Investora
Investor je oprávnený túto zmluvu uzavrieť a nadobúda práva z nej na investičné účely, nie s cieľom ich ďalšieho predaja.

Článok 5 – Záverečné ustanovenia
5.1 Táto zmluva sa spravuje právom Slovenskej republiky. Na spory je príslušný Mestský súd Bratislava III.
5.2 Zmluvu možno meniť len písomnými dodatkami podpísanými oboma zmluvnými stranami.

Za Severka Robotics, a.s.: Ing. Martin Šoltés, predseda predstavenstva

Za Tatra Horizon Capital, a.s.: Mgr. Andrej Halás, predseda predstavenstva`,

  [MARKETING_LOCALE_MARKERS.sk.redactedExtractFileName]:
    `DÔVERNÉ — ANONYMIZOVANÁ KÓPIA NA REVÍZIU

PROJEKT SEVERKA
VÝŤAH ZO SPRÁVY O PRÁVNEJ PREVERKE (DUE DILIGENCE)

1. ZMLUVNÉ STRANY

Cieľová spoločnosť: ███████████████████████, IČO: ████████
Sídlo: █████████████████████████████████
Predávajúci: ██████████████████████████████
Kupujúci: Severka Robotics, a.s.

2. HODNOTA TRANSAKCIE

Navrhovaná kúpna cena je ███████████ eur a podlieha úprave o čistý pracovný kapitál podľa prílohy č. 4. Zádržné vo výške ████████ eur bude zložené do notárskej úschovy u notára ███████████████.

3. KĽÚČOVÉ ZISTENIA

a) Cieľová spoločnosť je stranou zmluvy o pripojení do distribučnej sústavy so spoločnosťou ███████████████. Zmluva obsahuje doložku o zmene kontroly, ktorá vyžaduje písomný súhlas pred dokončením transakcie.

b) Na súde prebieha pracovnoprávny spor so zamestnancom ██████████████, nar. ██████████, r. č. ██████/████, bytom ████████████████████. Externý advokát odhaduje maximálnu expozíciu na ████████ eur.

c) Úver od banky ████████████ je zabezpečený záložným právom k transformovni; splátky sa uhrádzajú z účtu IBAN SK██ ████ ████ ████ ████ ████.

4. ODPORÚČANIE

Získať súhlas so zmenou kontroly, požadovať osobitné odškodnenie za prebiehajúci spor a zadržať ████████ eur z kúpnej ceny do jeho právoplatného skončenia.

Pripravené na interné posúdenie. Mená fyzických osôb, rodné čísla, adresy, protistrany, čísla účtov a obchodne citlivé sumy boli anonymizované.`,

  // ws-stavebni-spor
  "Zaloba_o_nahradu_skody.pdf": `ŽALOBA O NÁHRADU ŠKODY

Mestský súd Košice
Štúrova 29
041 51 Košice

Žalobca: Košická stavebná spoločnosť, s.r.o., IČO: 46213578, so sídlom Južná trieda 78, 040 01 Košice
Zastúpený: Hrabovský & Partneri, advokátska kancelária, s.r.o., v mene ktorej koná JUDr. Petra Hrabovská, advokátka

Žalovaný: Betón Hornád, s.r.o., IČO: 50417365, so sídlom Rastislavova 98, 040 01 Košice

o zaplatenie 412 600 eur s príslušenstvom

I. Skutkový stav
Žalobca ako generálny zhotoviteľ polyfunkčného objektu „Rezidencia Hornád“ uzavrel so žalovaným dňa 14. 3. 2023 zmluvu o dielo č. 2023/017 podľa § 536 a nasl. Obchodného zákonníka na zhotovenie monolitickej železobetónovej konštrukcie. Žalovaný dielo odovzdal 30. 11. 2023. V apríli 2025 sa na stropných doskách 2. a 3. nadzemného podlažia objavili trhliny, ktoré si vyžiadali okamžité podopretie konštrukcie.

II. Znalecké dokazovanie
Podľa znaleckého posudku Ing. Vladimíra Tomka, PhD., č. 7/2025 je príčinou porúch použitie betónu nižšej pevnostnej triedy (C20/25 namiesto projektovanej C30/37) a nedostatočné krytie výstuže (15 mm namiesto minimálne 30 mm).

III. Právne posúdenie
Žalovaný zodpovedá za vady diela podľa § 560 a nasl. Obchodného zákonníka a za škodu spôsobenú porušením zmluvných povinností podľa § 373 Obchodného zákonníka. Žalobca vady reklamoval listom zo dňa 22. 4. 2025, žalovaný nárok odmietol.

IV. Návrh rozsudku
Žalobca navrhuje, aby súd rozhodol takto:
Žalovaný je povinný zaplatiť žalobcovi 412 600 eur s úrokom z omeškania vo výške základnej úrokovej sadzby ECB zvýšenej o 9 percentuálnych bodov ročne od 15. 6. 2025 do zaplatenia, a to do 3 dní od právoplatnosti rozsudku. Žalovaná suma pozostáva z:
  a) 318 400 eur – náklady na sanáciu stropných konštrukcií;
  b) 61 200 eur – náklady na dočasné podopretie a predĺženie výstavby;
  c) 33 000 eur – znalecké a projektové náklady.
Žalobcovi sa priznáva nárok na náhradu trov konania v rozsahu 100 %.

V Bratislave dňa 21. 10. 2025`,

  "Znalecky_posudok_stavba.pdf": `ZNALECKÝ POSUDOK č. 7/2025
Predmet: Posúdenie príčin statických porúch stropných dosiek objektu „Rezidencia Hornád“, Košice

Znalec: Ing. Vladimír Tomko, PhD., znalec v odbore Stavebníctvo, odvetvie: Pozemné stavby, evidenčné číslo: 912644
Zadávateľ: Košická stavebná spoločnosť, s.r.o.

NÁLEZ:
1. Na stropných doskách 2. a 3. nadzemného podlažia sú trhliny šírky 0,6 – 2,1 mm v miestach maximálnych ohybových momentov.
2. Jadrové vývrty preukázali pevnosť betónu v tlaku 24,8 MPa, čo zodpovedá triede C20/25; projektová dokumentácia predpisuje C30/37.
3. Krycia vrstva výstuže je v priemere 15 mm; minimum podľa STN EN 1992-1-1 pre triedu prostredia XC3 je 30 mm.
4. Stavebný denník neobsahuje záznamy o preberaní dodávok betónu ani o skúškach konzistencie na stavenisku.

ZÁVER:
Príčinou zistených porúch je jednoznačne:
  a) použitie betónu nižšej pevnostnej triedy, než predpisuje projekt;
  b) nedodržanie minimálneho krytia výstuže.
Obe vady vznikli pri zhotovovaní diela a sú dôsledkom nedostatočnej kontroly kvality zo strany zhotoviteľa.

Odhadované náklady na sanáciu: 318 400 eur bez DPH.

ZNALECKÁ DOLOŽKA
Znalecký úkon som vykonal ako znalec zapísaný v zozname znalcov, tlmočníkov a prekladateľov pod evidenčným číslom 912644. Som si vedomý následkov vedome nepravdivého znaleckého posudku.

V Košiciach dňa 9. 6. 2025`,

  "Zapisnica_z_obhliadky_stavby.docx": `ZÁPISNICA Z OBHLIADKY STAVBY

Stavba: polyfunkčný objekt „Rezidencia Hornád“, Košice
Dátum a čas: 12. 5. 2025, 9:00 – 12:30

Prítomní:
- za objednávateľa: Ing. Michal Gajdoš, stavbyvedúci, Košická stavebná spoločnosť, s.r.o.
- za zhotoviteľa: Ing. Pavol Fedor, konateľ, Betón Hornád, s.r.o.
- znalec: Ing. Vladimír Tomko, PhD.
- právna zástupkyňa objednávateľa: JUDr. Petra Hrabovská

Priebeh obhliadky:
1. Prítomní spoločne prezreli stropné dosky 2. a 3. nadzemného podlažia. Trhliny sú viditeľné voľným okom, najmä v strede polí medzi stĺpmi C2 – C4.
2. Znalec odobral 6 jadrových vývrtov na skúšku pevnosti betónu v tlaku. Miesta odberu sú vyznačené vo výkrese, ktorý tvorí prílohu č. 1 zápisnice.
3. Na dvoch miestach znalec odkryl výstuž a zmeral hrúbku krycej vrstvy (14 mm a 16 mm).
4. Zástupca zhotoviteľa namietal, že trhliny vznikli predčasným odstránením podpier objednávateľom.

Vyjadrenie objednávateľa:
Podpery odstraňoval zhotoviteľ sám, čo potvrdzuje zápis v stavebnom denníku zo dňa 2. 10. 2023.

Prílohy: 1. výkres odberných miest, 2. fotodokumentácia (42 snímok)

Zápisnicu po prečítaní podpísali všetci prítomní; zástupca zhotoviteľa s výhradou podľa bodu 4.`,

  "Doplnenie_dokaznych_navrhov.pdf": `PODANIE – DOPLNENIE DÔKAZNÝCH NÁVRHOV

Mestský súd Košice
sp. zn. 27Cb/118/2025

Žalobca: Košická stavebná spoločnosť, s.r.o.
Žalovaný: Betón Hornád, s.r.o.

V lehote určenej uznesením súdu zo dňa 3. 2. 2026 žalobca dopĺňa svoje dôkazné návrhy takto:

1. Výsluch svedka Ing. Michala Gajdoša, stavbyvedúceho žalobcu, na preukázanie, že podpery stropných dosiek odstraňoval žalovaný.

2. Listinné dôkazy:
  a) stavebný denník, zápisy z obdobia od 18. 9. 2023 do 30. 11. 2023;
  b) dodacie listy betónu od dodávateľa žalovaného;
  c) protokoly o skúškach betónu, ktoré žalovaný neodovzdal pri odovzdaní diela.

3. Žalobca navrhuje, aby súd uložil žalovanému predložiť protokoly o skúškach betónu, ktoré má žalovaný k dispozícii.

4. K námietke žalovaného, že vady spôsobil žalobca, žalobca uvádza, že znalecký posudok č. 7/2025 vylučuje predčasné odstránenie podpier ako príčinu porúch.

V Bratislave dňa 24. 2. 2026

JUDr. Petra Hrabovská, advokátka`,

  // ws-due-diligence
  "Kontrolny_zoznam_DD.pdf": `KONTROLNÝ ZOZNAM PRÁVNEJ PREVERKY

Cieľová spoločnosť: Vertiq Systems, s.r.o.
Projekt: Projekt Atlas – právna preverka
Klient: Tatra Horizon Capital, a.s.
Dátum: január 2025

1. KORPORÁTNE DOKUMENTY
  [✓] Výpis z obchodného registra
  [✓] Spoločenská zmluva (úplné znenie)
  [✓] Zoznam spoločníkov a register partnerov verejného sektora
  [✗] Zápisnice z valných zhromaždení za posledné 3 roky (predložené len za 2 roky)
  [✓] Plnomocenstvá a prokúry

2. ZMLUVY
  [✓] Zmluvy s odberateľmi (20 najväčších podľa obratu)
  [✓] Zmluvy s dodávateľmi
  [✗] Preverenie doložiek o zmene kontroly (prebieha)
  [✓] Nájomné zmluvy

3. PRACOVNOPRÁVNA OBLASŤ
  [✓] Pracovné zmluvy (vzor a odchýlky)
  [✓] Kolektívna zmluva
  [✗] Zamestnanecký opčný program (chýba harmonogram nároku)
  [✓] Dohody o konkurenčnej doložke

4. DUŠEVNÉ VLASTNÍCTVO
  [✓] Patenty a úžitkové vzory (2 SK, 1 EP)
  [✓] Ochranné známky
  [✗] Audit licencií open source (čaká sa)
  [✓] Licenčné zmluvy na softvér

5. SPORY
  [✓] Prebiehajúce konania (1 menší pracovnoprávny spor, 15 000 eur)
  [✓] Kontroly a vyšetrovania orgánov dozoru (žiadne)
  [✓] Daňové kontroly

Celkové plnenie: 80 % (16 z 20 položiek)
Chýbajúce podklady doplniť do 15. 2. 2025.`,

  "Struktura_skupiny_Vertiq.pdf": `ŠTRUKTÚRA SKUPINY – PROJEKT ATLAS

Vertiq Group B.V. (Holandsko)
  │
  ├── 100 % Vertiq Systems, s.r.o. (Slovensko, Košice)
  │     ├── 51 % Vertiq Labs, s.r.o. (Slovensko, Žilina)
  │     └── 100 % Vertiq Services Kft. (Maďarsko)
  │
  ├── 100 % Vertiq Software GmbH (Rakúsko)
  │     └── 100 % Vertiq Consulting s.r.o. (Česko)
  │
  └── 80 % Vertiq Polska sp. z o.o. (Poľsko)

Kľúčové finančné údaje (konsolidované za rok 2024):
- Tržby: 38,6 mil. eur
- EBITDA: 7,4 mil. eur
- Zamestnanci: 284 (SK: 171, HU: 41, AT: 38, PL: 34)
- Čistý dlh: 2,9 mil. eur

Regulačné poznámky:
- Slovenská dcérska spoločnosť má živnostenské oprávnenia na služby IT
- Vertiq Systems, s.r.o. je zapísaná v registri partnerov verejného sektora; zmenu konečného užívateľa výhod treba zapísať do 60 dní
- Maďarská spoločnosť využíva zjednodušený daňový režim`,

  "Navrh_zmluvy_o_prevode_podielu_v3.docx": `ZMLUVA O PREVODE OBCHODNÉHO PODIELU – NÁVRH v3.2

Zmluvné strany:
(1) Vertiq Group B.V., so sídlom Amsterdam, Holandsko (ďalej len „Prevodca“)
(2) Tatra Horizon Capital, a.s., so sídlom Karadžičova 8, 821 08 Bratislava (ďalej len „Nadobúdateľ“)

Vo veci: prevod 100 % obchodného podielu v spoločnosti Vertiq Systems, s.r.o.

ČLÁNOK 1 – VYMEDZENIE POJMOV
„Pracovný deň“ je každý deň okrem soboty, nedele a dňa pracovného pokoja v Slovenskej republike alebo v Holandsku.
„Deň dokončenia“ je piaty Pracovný deň po splnení všetkých odkladacích podmienok.
„Podstatná nepriaznivá zmena“ je udalosť, ktorá zníži EBITDA o viac ako 15 % oproti auditovanej účtovnej závierke za rok 2024.

ČLÁNOK 2 – KÚPNA CENA
2.1 Kúpna cena je 33 500 000 eur (slovom: tridsaťtri miliónov päťstotisíc eur).
2.2 Kúpna cena sa určuje mechanizmom locked box k rozhodujúcemu dňu 31. 12. 2024.
2.3 Povolený únik hodnoty: mzdy, nájomné a bežné obchodné záväzky.

ČLÁNOK 3 – ODKLADACIE PODMIENKY
3.1 Súhlas Protimonopolného úradu SR s koncentráciou (bez druhej fázy konania);
3.2 súhlas kľúčových odberateľov, ktorí predstavujú viac ako 60 % tržieb;
3.3 nenastanie Podstatnej nepriaznivej zmeny medzi podpisom a Dňom dokončenia.

ČLÁNOK 4 – VYHLÁSENIA A ZÁRUKY
Prevodca vyhlasuje, že informácie v dátovej miestnosti sú ku dňu podpisu pravdivé a úplné. [Rozsah obmedzenia zodpovednosti: ●]

[ZVYŠOK PREDMETOM ROKOVANIA]`,

  "Sprava_o_regulatornom_sulade.pdf": `SPRÁVA O REGULATÓRNOM SÚLADE
Vertiq Systems, s.r.o. – Projekt Atlas

1. OCHRANA OSOBNÝCH ÚDAJOV (GDPR, zákon č. 18/2018 Z. z.)
Stav: ČIASTOČNÝ SÚLAD
- Zmluvy so sprostredkovateľmi uzavreté s 12 z 15 subdodávateľov (3 chýbajú)
- Posúdenie vplyvu (DPIA) vypracované pre analytický modul zákazníkov
- Postup pri porušení ochrany osobných údajov je zavedený
- Chýba: zodpovedná osoba (povinná pre rozsiahle spracúvanie)
Odporúčanie: určiť zodpovednú osobu pred dokončením; rozpočet 40 000 eur ročne

2. ŽIVNOSTENSKÉ OPRÁVNENIA
Stav: V SÚLADE
- Všetky potrebné živnostenské oprávnenia sú platné
- Maďarské podnikateľské oprávnenie obnovené v októbri 2024

3. PRACOVNOPRÁVNE PREDPISY
Stav: V SÚLADE S DROBNÝMI NEDOSTATKAMI
- Požiadavky Zákonníka práce sú splnené
- Evidencia pracovného času: 2 prípady nesúladu v 3. štvrťroku 2024
- Kolektívna zmluva je platná do 31. 3. 2026
Úroveň rizika: NÍZKA

4. REGISTER PARTNEROV VEREJNÉHO SEKTORA
Stav: V SÚLADE
Poznámka: po dokončení transakcie treba prostredníctvom oprávnenej osoby zapísať nového konečného užívateľa výhod.

Celkové hodnotenie rizika: NÍZKE AŽ STREDNÉ
Odhadované náklady na nápravu: 55 000 – 75 000 eur`,

  // ws-pracovni-spory
  "Vypoved_z_pracovneho_pomeru.pdf": `VÝPOVEĎ Z PRACOVNÉHO POMERU

Zamestnávateľ: Strojárne Liptov, a.s., IČO: 36412881, so sídlom Priemyselná 2, 031 01 Liptovský Mikuláš

Zamestnanec: Ing. Marek Lukáč, nar. 3. 8. 1982, bytom Štúrova 22, 031 01 Liptovský Mikuláš

Podľa § 63 ods. 1 písm. b) Zákonníka práce Vám dávame výpoveď z pracovného pomeru, pretože ste sa stali nadbytočným vzhľadom na rozhodnutie zamestnávateľa o organizačných zmenách. Predstavenstvo rozhodlo dňa 2. 6. 2025 o zrušení pracovného miesta vedúceho oddelenia údržby, ktoré zastávate.

Zamestnávateľ Vám nemôže ponúknuť inú vhodnú prácu v mieste výkonu práce ani v mieste Vášho bydliska, preto ponuková povinnosť podľa § 63 ods. 2 Zákonníka práce nevznikla.

Výpoveď bola prerokovaná so zástupcami zamestnancov dňa 9. 6. 2025.

Výpovedná doba je tri mesiace a začína plynúť prvým dňom kalendárneho mesiaca nasledujúceho po doručení tejto výpovede.

Pri skončení pracovného pomeru Vám patrí odstupné podľa § 76 Zákonníka práce a kolektívnej zmluvy.

V Liptovskom Mikuláši dňa 16. 6. 2025

Za zamestnávateľa: Ing. Silvia Mináriková, personálna riaditeľka`,

  "Zaloba_o_neplatnost_vypovede.pdf": `ŽALOBA O URČENIE NEPLATNOSTI SKONČENIA PRACOVNÉHO POMERU

Okresný súd Žilina
Hurbanova 35
010 01 Žilina

Žalobca: Ing. Marek Lukáč, nar. 3. 8. 1982, bytom Štúrova 22, 031 01 Liptovský Mikuláš
Zastúpený: Ružička a spol., advokátska kancelária, s.r.o., v mene ktorej koná JUDr. Ondrej Ružička, advokát

Žalovaný: Strojárne Liptov, a.s., IČO: 36412881, so sídlom Priemyselná 2, 031 01 Liptovský Mikuláš

I. Skutkový stav
Žalovaný dal žalobcovi dňa 16. 6. 2025 výpoveď podľa § 63 ods. 1 písm. b) Zákonníka práce pre nadbytočnosť. Žalobca žalobu podáva v lehote dvoch mesiacov podľa § 77 Zákonníka práce.

II. Dôvody neplatnosti výpovede
1. Organizačná zmena sa v skutočnosti neuskutočnila: miesto vedúceho údržby sa iba premenovalo na „manažér údržby a spoľahlivosti“ a od 1. 8. 2025 ho obsadil iný zamestnanec.
2. Žalovaný porušil ponukovú povinnosť podľa § 63 ods. 2 Zákonníka práce, hoci v čase výpovede bolo voľné miesto technológa výroby.
3. Prerokovanie so zástupcami zamestnancov bolo iba formálne a uskutočnilo sa až po podpise výpovede.

III. Návrh rozsudku
Žalobca navrhuje, aby súd:
  a) určil, že výpoveď z pracovného pomeru zo dňa 16. 6. 2025 je neplatná;
  b) uložil žalovanému povinnosť zaplatiť žalobcovi náhradu mzdy podľa § 79 Zákonníka práce;
  c) priznal žalobcovi nárok na náhradu trov konania v rozsahu 100 %.

V Žiline dňa 8. 8. 2025`,

  "Pracovna_zmluva.docx": `PRACOVNÁ ZMLUVA
uzavretá podľa § 42 a nasl. zákona č. 311/2001 Z. z. Zákonník práce

Zamestnávateľ: Strojárne Liptov, a.s., IČO: 36412881, Priemyselná 2, 031 01 Liptovský Mikuláš
Zamestnanec: Ing. Marek Lukáč, nar. 3. 8. 1982

1. Druh práce: vedúci oddelenia údržby
2. Miesto výkonu práce: Liptovský Mikuláš, Priemyselná 2
3. Deň nástupu do práce: 1. 3. 2017
4. Pracovný pomer sa uzatvára na dobu neurčitú
5. Skúšobná doba: 6 mesiacov (vedúci zamestnanec)
6. Mzda: 2 850 eur mesačne (mzdový výmer tvorí prílohu č. 1)
7. Týždenný pracovný čas: 37,5 hodiny (dvojzmenná prevádzka)
8. Dovolenka: 5 týždňov ročne podľa kolektívnej zmluvy
9. Výpovedná doba: podľa § 62 Zákonníka práce

Zamestnanec potvrdzuje, že sa oboznámil s pracovným poriadkom, predpismi o bezpečnosti a ochrane zdravia pri práci a s kolektívnou zmluvou.

V Liptovskom Mikuláši dňa 20. 2. 2017

Za zamestnávateľa: Ing. Silvia Mináriková, personálna riaditeľka
Zamestnanec: Ing. Marek Lukáč`,

  "Zapisnica_o_vypovedi_svedka.pdf": `ZÁPISNICA O VÝSLUCHU SVEDKA

Okresný súd Žilina
sp. zn. 18Cpr/42/2025

Svedok: Ing. Katarína Ondrušková, nar. 12. 4. 1988
Vzťah k stranám: zamestnankyňa žalovaného, vedúca plánovania výroby

Svedkyňa bola poučená o povinnosti vypovedať pravdivo a nič nezamlčať a o trestných následkoch krivej výpovede.

Výpoveď:
„V Strojárňach Liptov pracujem od roku 2014. K organizačnej zmene z júna 2025 môžem uviesť toto:

Rozhodnutie o zrušení miesta vedúceho údržby pripravoval výrobný riaditeľ. Na porade som upozornila, že pána Lukáča by bolo možné preradiť na voľné miesto technológa výroby. Odpoveď bola, že na toto miesto je už vybraný externý uchádzač.

Od 1. 8. 2025 pracuje na novom mieste ‚manažér údržby a spoľahlivosti‘ Ing. Tibor Halaj. Náplň jeho práce sa podľa mňa z veľkej časti zhoduje s pôvodnou prácou pána Lukáča.“

Na otázku zástupcu žalovaného svedkyňa uviedla, že organizačný poriadok neschvaľovala a pozná ho iba z porád.

V Žiline dňa 10. 11. 2025`,

  // ws-compliance-ceska-energie
  "Compliance_manual_2025.pdf": `COMPLIANCE MANUÁL 2025
Hronská energetika, a.s.

1. ÚVOD
Tento manuál upravuje pravidlá dodržiavania regulačných požiadaviek, etických noriem a vnútorných predpisov spoločnosti Hronská energetika, a.s. Vychádza aj z rizika trestnej zodpovednosti právnických osôb podľa zákona č. 91/2016 Z. z.

2. PROTIKORUPČNÉ PRAVIDLÁ
2.1 Zakazuje sa prijímať a poskytovať úplatky v akejkoľvek forme, priamo aj cez tretie osoby.
2.2 Dary a pohostenie: najviac 50 eur na osobu a rok; každý dar sa zapisuje do registra darov.
2.3 Sponzorstvo a dary obciam schvaľuje výlučne predstavenstvo.

3. KONFLIKT ZÁUJMOV
Každý zamestnanec je povinný oznámiť konflikt záujmov na formulári KZ-01 do 5 pracovných dní od jeho zistenia.

4. TRH S ENERGIOU (REMIT)
Obchodovanie s elektrinou a plynom podlieha nariadeniu (EÚ) č. 1227/2011. Zakazuje sa obchodovať na základe dôverných informácií a manipulovať s trhom; podozrivé obchody sa hlásia ÚRSO.

5. OZNAMOVANIE PROTISPOLOČENSKEJ ČINNOSTI
Oznámenie možno podať:
  a) e-mailom: oznamovanie@hronska-energetika.example
  b) telefonicky na internej linke 5555
  c) poštou: zodpovedná osoba, Hronská energetika, a.s., Mlynské nivy 48, 821 09 Bratislava
Ochranu oznamovateľa zaručuje zákon č. 54/2019 Z. z.

6. SANKCIE ZA PORUŠENIE
Podľa závažnosti porušenia: písomné upozornenie, skončenie pracovného pomeru, trestné oznámenie.

Platnosť: 1. 1. 2025 – 31. 12. 2025
Schválila: Ing. Lucia Benková, vedúca compliance`,

  "Hodnotenie_korupcnych_rizik.pdf": `HODNOTENIE KORUPČNÝCH RIZÍK
Hronská energetika, a.s. – ročné hodnotenie 2025

ZHRNUTIE
Celková úroveň rizika: STREDNÁ

1. VEREJNÉ OBSTARÁVANIE A ZÁKAZKY
- Hodnota zákaziek zadaných v roku 2024: 41,2 mil. eur
- Zákazky zadané bez súťaže: 6 (spolu 1,8 mil. eur), všetky s písomným odôvodnením
- Riziko: STREDNÉ – zúžený okruh dodávateľov pri údržbe vedení

2. VZŤAHY S VEREJNÝMI FUNKCIONÁRMI
- Identifikované kontakty pri povoľovaní stavieb: 14 obcí, 3 okresné úrady
- Dary a sponzorstvo obciam: 112 000 eur, všetky schválené predstavenstvom
- Riziko: STREDNÉ

3. OBCHODOVANIE S ENERGIOU
- Počet obchodníkov s prístupom k dôverným informáciám: 9
- Hlásenia podozrivých obchodov podľa REMIT: 0
- Riziko: NÍZKE

4. TRETIE STRANY
- Preverenie dodávateľov nad 100 000 eur: 87 % (cieľ 100 %)
- Dodávatelia s neprehľadnou vlastníckou štruktúrou: 2 (bez zápisu v registri partnerov verejného sektora)
- Riziko: VYSOKÉ

5. ODPORÚČANIA
  a) Rozšíriť preverovanie na všetkých dodávateľov nad 100 000 eur do 30. 6. 2025
  b) Ukončiť zmluvy s dodávateľmi bez zápisu v registri partnerov verejného sektora
  c) Zaviesť štvoroké schvaľovanie zákaziek bez súťaže

Vypracovala: Ing. Lucia Benková, vedúca compliance
Dátum: 28. 2. 2025`,

  "Sprava_z_interneho_auditu.docx": `SPRÁVA Z INTERNÉHO AUDITU č. 2025/07
Hronská energetika, a.s.

Predmet auditu: Dodržiavanie pravidiel o daroch a konflikte záujmov
Obdobie: 1. 1. 2024 – 30. 6. 2025
Audítorský tím: Ing. Juraj Pekár (vedúci), Bc. Tímea Kissová

1. ROZSAH
Preverili sme register darov, 214 oznámení o konflikte záujmov a vzorku 60 zákaziek zadaných divíziou distribúcie.

2. ZISTENIA
2.1 Dary prijaté 3 zamestnancami (spolu 640 eur) neboli zapísané do registra darov.
2.2 V 2 zákazkách hodnotil ponuky zamestnanec, ktorý mal s uchádzačom príbuzenský vzťah; konflikt záujmov neoznámil.
2.3 Oznámenia o konflikte záujmov sa neaktualizujú pri zmene pracovného zaradenia.

3. HODNOTENIE
Kontrolné prostredie je funkčné, ale pri zákazkách divízie distribúcie má nedostatky. Celkové hodnotenie: ČIASTOČNE ÚČINNÉ.

4. NÁPRAVNÉ OPATRENIA
  a) Doplniť register darov a zamestnancov upozorniť písomne – termín 31. 8. 2025
  b) Prešetriť 2 zákazky a posúdiť pracovnoprávne následky – termín 30. 9. 2025
  c) Zaviesť každoročné potvrdenie oznámení o konflikte záujmov – termín 31. 12. 2025

V Bratislave dňa 18. 7. 2025`,

  "Skolenie_compliance_2025.pdf": `ŠKOLENIE COMPLIANCE 2025
Hronská energetika, a.s. – povinné ročné školenie

MODUL 1: PREČO NA COMPLIANCE ZÁLEŽÍ
- Právnická osoba môže byť trestne zodpovedná podľa zákona č. 91/2016 Z. z.
- Hrozí peňažný trest, zákaz účasti vo verejnom obstarávaní a strata dôvery regulátora
- Za porušenie zodpovedá aj konkrétny zamestnanec

MODUL 2: DARY A POHOSTENIE
- Limit 50 eur na osobu a rok
- Každý dar zapíšte do registra darov do 5 pracovných dní
- Peňažné dary a poukážky sa neprijímajú nikdy

MODUL 3: KONFLIKT ZÁUJMOV
- Príbuzný u dodávateľa, vedľajšia činnosť, podiel v spoločnosti uchádzača
- Oznámenie na formulári KZ-01 vždy pred začatím hodnotenia ponúk

MODUL 4: REMIT A DÔVERNÉ INFORMÁCIE
- Informácie o odstávkach zdrojov a vedení sú dôverné až do ich zverejnenia
- Obchodovanie na ich základe je zakázané aj pre rodinných príslušníkov

MODUL 5: AKO PODAŤ OZNÁMENIE
- Interný kanál podľa zákona č. 54/2019 Z. z., anonymne alebo s menom
- Oznamovateľ je chránený pred odvetnými opatreniami

ZÁVEREČNÝ TEST
10 otázok, na úspešné absolvovanie treba aspoň 8 správnych odpovedí.

Termín absolvovania: do 30. 11. 2025`,

  // ws-reorganizace
  "Reorganizacny_plan.pdf": `REORGANIZAČNÝ PLÁN
Skupina Strojárne Liptov

1. CIEĽ
Zjednodušiť štruktúru skupiny, znížiť administratívne náklady a oddeliť servisné činnosti od výroby.

2. VÝCHODISKOVÝ STAV
Strojárne Liptov, a.s. je jediným spoločníkom štyroch dcérskych spoločností:
  a) Liptovská zlievareň, s.r.o. – odlievanie dielcov, 142 zamestnancov
  b) SL Komponenty, s.r.o. – obrábanie, 96 zamestnancov
  c) SL Servis, s.r.o. – servis a náhradné diely, 38 zamestnancov
  d) SL Reality, s.r.o. – správa výrobných areálov, 7 zamestnancov

3. KROKY REORGANIZÁCIE
Krok 1: Zlúčenie spoločností Liptovská zlievareň, s.r.o. a SL Komponenty, s.r.o. so spoločnosťou Strojárne Liptov, a.s. ako nástupníckou spoločnosťou; rozhodný deň 1. 1. 2026.
Krok 2: Vklad časti podniku „Servis“ do spoločnosti SL Servis, s.r.o.
Krok 3: Založenie holdingovej spoločnosti SL Holding, a.s., do ktorej akcionári vložia akcie spoločnosti Strojárne Liptov, a.s.; Strojárne Liptov, a.s. na ňu prevedú obchodný podiel v SL Reality, s.r.o.

4. PRACOVNOPRÁVNE DÔSLEDKY
Práva a povinnosti z pracovnoprávnych vzťahov zamestnancov zanikajúcich spoločností prechádzajú na nástupnícku spoločnosť podľa § 27 a nasl. Zákonníka práce. Zástupcov zamestnancov treba informovať najneskôr jeden mesiac pred prechodom.

5. HARMONOGRAM
- 9/2025: schválenie zmluvy o zlúčení valnými zhromaždeniami
- 10/2025: návrh na zápis do obchodného registra
- 1/2026: účinnosť zlúčenia zápisom do obchodného registra
- 3/2026: vklad časti podniku a založenie SL Holding, a.s.

Vypracovala: Hrabovský & Partneri, advokátska kancelária, s.r.o.`,

  "Zmluva_o_zluceni.pdf": `ZMLUVA O ZLÚČENÍ
uzavretá podľa § 69 a § 218a a nasl. zákona č. 513/1991 Zb. Obchodný zákonník

Zúčastnené spoločnosti:
1. Strojárne Liptov, a.s., IČO: 36412881, so sídlom Priemyselná 2, 031 01 Liptovský Mikuláš (nástupnícka spoločnosť)
2. Liptovská zlievareň, s.r.o., IČO: 44128735, so sídlom Priemyselná 3, 031 01 Liptovský Mikuláš (zanikajúca spoločnosť)
3. SL Komponenty, s.r.o., IČO: 46871290, so sídlom Priemyselná 5, 031 01 Liptovský Mikuláš (zanikajúca spoločnosť)

Článok 1 – Predmet zmluvy
Zanikajúce spoločnosti sa zrušujú bez likvidácie a zlučujú sa s nástupníckou spoločnosťou, na ktorú prechádza celé ich imanie vrátane práv a povinností z pracovnoprávnych vzťahov.

Článok 2 – Výmenný pomer
Nástupnícka spoločnosť je jediným spoločníkom oboch zanikajúcich spoločností, preto sa akcie nástupníckej spoločnosti nevydávajú a výmenný pomer sa neurčuje.

Článok 3 – Rozhodný deň
Rozhodným dňom je 1. 1. 2026. Od tohto dňa sa úkony zanikajúcich spoločností považujú z účtovného hľadiska za úkony nástupníckej spoločnosti.

Článok 4 – Orgány a práva akcionárov
4.1 Zloženie predstavenstva a dozornej rady nástupníckej spoločnosti sa nemení.
4.2 Žiadnej osobe sa neposkytujú osobitné výhody v súvislosti so zlúčením.

Článok 5 – Záverečné ustanovenia
5.1 Zlúčenie nadobúda účinnosť dňom zápisu do obchodného registra.
5.2 Táto zmluva sa vyhotovuje vo forme notárskej zápisnice a podlieha schváleniu valných zhromaždení všetkých zúčastnených spoločností.

V Liptovskom Mikuláši dňa 10. 9. 2025`,

  "Zapisnica_z_valneho_zhromazdenia.docx": `ZÁPISNICA Z MIMORIADNEHO VALNÉHO ZHROMAŽDENIA
Strojárne Liptov, a.s., IČO: 36412881

Dátum a miesto: 25. 9. 2025, 10:00, sídlo spoločnosti, Priemyselná 2, Liptovský Mikuláš
Predseda valného zhromaždenia: JUDr. Petra Hrabovská
Zapisovateľ: Mgr. Branislav Mikula
Overovatelia zápisnice: Ing. Ján Kováčik, Ing. Eva Štefániková
Prítomní akcionári: akcionári s akciami s menovitou hodnotou predstavujúcou 94,6 % základného imania; valné zhromaždenie je uznášaniaschopné.

PROGRAM:
1. Otvorenie a voľba orgánov valného zhromaždenia
2. Schválenie zmluvy o zlúčení so spoločnosťami Liptovská zlievareň, s.r.o. a SL Komponenty, s.r.o.
3. Schválenie zmeny stanov
4. Záver

K bodu 2:
Predseda predstavenstva predniesol správu o zlúčení. Akcionári boli upozornení na právo nahliadnuť do zmluvy o zlúčení a účtovných závierok zúčastnených spoločností najmenej jeden mesiac pred konaním valného zhromaždenia.

Uznesenie č. 2/2025: Valné zhromaždenie schvaľuje zmluvu o zlúčení zo dňa 10. 9. 2025.
Hlasovanie: za 94,6 %, proti 0 %, zdržali sa 0 %. Uznesenie bolo prijaté.

K bodu 3:
Uznesenie č. 3/2025: Valné zhromaždenie schvaľuje rozšírenie predmetu podnikania o zlievarenskú výrobu.
Hlasovanie: za 94,6 %, proti 0 %, zdržali sa 0 %. Uznesenie bolo prijaté.

Priebeh valného zhromaždenia a prijaté uznesenia osvedčila notárka zápisnicou č. N 412/2025, Nz 31877/2025.

Predseda valného zhromaždenia: JUDr. Petra Hrabovská
Zapisovateľ: Mgr. Branislav Mikula`,

  "Schema_holdingovej_struktury.pdf": `SCHÉMA HOLDINGOVEJ ŠTRUKTÚRY – PO REORGANIZÁCII

SL Holding, a.s. (Liptovský Mikuláš)
  │
  ├── 100 % Strojárne Liptov, a.s.
  │     ├── divízia Zlievareň (bývalá Liptovská zlievareň, s.r.o.)
  │     ├── divízia Obrábanie (bývalá SL Komponenty, s.r.o.)
  │     └── 100 % SL Servis, s.r.o. (vrátane vloženej časti podniku „Servis“)
  │
  └── 100 % SL Reality, s.r.o. (správa výrobných areálov)

Porovnanie pred reorganizáciou a po nej:
- Počet právnických osôb: 5 → 4
- Štatutárne orgány: 5 → 4
- Účtovné závierky a audity: 4 → 3 (úspora približne 85 000 eur ročne)
- Zamestnanci nástupníckej spoločnosti: 512 → 750

Poznámky:
- Akcionári vložia akcie Strojární Liptov, a.s. do SL Holding, a.s. ako nepeňažný vklad ocenený znaleckým posudkom
- Daňové dôsledky nepeňažného vkladu posúdi daňový poradca skupiny pred podaním návrhu na zápis
- Úverové zmluvy skupiny treba preveriť pre doložky o zmene kontroly`,

  // ws-cross-border
  "Term_sheet_Projekt_Dunaj.pdf": `TERM SHEET – CEZHRANIČNÁ AKVIZÍCIA
Projekt Dunaj

Nezáväzný návrh (okrem ustanovení o dôvernosti a exkluzivite)

1. ZMLUVNÉ STRANY
Kupujúci: Tatra Horizon Capital, a.s., Bratislava, prostredníctvom účelovej spoločnosti THC Dunaj, s.r.o.
Predávajúci: Marchfeld Industriebeteiligungen GmbH, Viedeň
Cieľová spoločnosť: Donau Präzisionstechnik GmbH, Viedeň, a jej dcérske spoločnosti DPT Slovakia, s.r.o. (Dunajská Streda) a DPT Hungária Kft. (Győr)

2. TRANSAKCIA
Kúpa 100 % obchodného podielu v cieľovej spoločnosti.

3. KÚPNA CENA
- Hodnota podniku: 62 000 000 eur
- Mechanizmus: locked box k 31. 3. 2025
- Earn-out: najviac 6 000 000 eur pri dosiahnutí EBITDA 2026 nad 9 500 000 eur

4. FINANCOVANIE
Vlastné zdroje fondu 55 % a bankový úver 45 %.

5. ODKLADACIE PODMIENKY
  a) Súhlas s koncentráciou od PMÚ SR, rakúskeho a maďarského súťažného úradu
  b) Preverenie zahraničných investícií v Rakúsku
  c) Súhlas kľúčových odberateľov so zmenou kontroly

6. EXKLUZIVITA
Do 30. 9. 2025.

7. ROZHODNÉ PRÁVO
Rakúske právo pre prevod obchodného podielu (forma notárskej zápisnice); slovenské právo pre zmluvu o kúpe; rozhodcovské konanie podľa Viedenských pravidiel.

V Bratislave dňa 12. 6. 2025`,

  "Oznamenie_koncentracie_PMU.pdf": `OZNÁMENIE KONCENTRÁCIE
Protimonopolný úrad Slovenskej republiky
podľa zákona č. 187/2021 Z. z. o ochrane hospodárskej súťaže

Projekt Dunaj

1. ÚČASTNÍCI KONCENTRÁCIE
Nadobúdateľ kontroly: Tatra Horizon Capital, a.s., IČO: 51936274, Karadžičova 8, 821 08 Bratislava
Nadobúdaná spoločnosť: Donau Präzisionstechnik GmbH, Viedeň, Rakúsko

2. OPIS KONCENTRÁCIE
Nadobudnutie výlučnej kontroly nad cieľovou spoločnosťou kúpou 100 % obchodného podielu.

3. SPLNENIE PRAHOV
- Celkový obrat účastníkov v SR v predchádzajúcom účtovnom období: 74,8 mil. eur
- Obrat nadobúdateľa (vrátane portfóliových spoločností) v SR: 58,3 mil. eur
- Obrat cieľovej skupiny v SR (DPT Slovakia, s.r.o.): 16,5 mil. eur
Koncentrácia podlieha kontrole úradu; podmienky príslušnosti Európskej komisie podľa nariadenia (ES) č. 139/2004 nie sú splnené.

4. RELEVANTNÉ TRHY
a) presné obrábané diely pre automobilový priemysel – prekrytie s portfóliovou spoločnosťou Považské presné diely, a.s.
   Spoločný podiel na trhu v SR: 17 %
b) hydraulické komponenty – bez prekrytia

5. POSÚDENIE
Koncentrácia nevedie k podstatnému obmedzeniu účinnej hospodárskej súťaže. Navrhujeme posúdenie v skrátenom konaní.

Za oznamovateľa: Hrabovský & Partneri, advokátska kancelária, s.r.o.
V Bratislave dňa 18. 7. 2025`,

  "Navrh_zmluvy_o_kupe_podielu_Dunaj.docx": `ZMLUVA O KÚPE OBCHODNÉHO PODIELU – NÁVRH v2.1
Projekt Dunaj

Zmluvné strany:
(1) Marchfeld Industriebeteiligungen GmbH, so sídlom Viedeň, Rakúsko (ďalej len „Predávajúci“)
(2) THC Dunaj, s.r.o., so sídlom Karadžičova 8, 821 08 Bratislava (ďalej len „Kupujúci“)
(3) Tatra Horizon Capital, a.s., ako ručiteľ za záväzky Kupujúceho

ČLÁNOK 1 – PREDMET ZMLUVY
1.1 Predávajúci predáva Kupujúcemu obchodný podiel predstavujúci 100 % základného imania spoločnosti Donau Präzisionstechnik GmbH.
1.2 Samotný prevod obchodného podielu sa uskutoční notárskou zápisnicou podľa rakúskeho práva v Deň dokončenia.

ČLÁNOK 2 – KÚPNA CENA
2.1 Kúpna cena je 62 000 000 eur znížená o čistý dlh k 31. 3. 2025 [výška čistého dlhu: ●].
2.2 Earn-out najviac 6 000 000 eur podľa prílohy č. 3.
2.3 Suma 4 000 000 eur sa uloží na viazaný účet na zabezpečenie nárokov zo záruk počas 18 mesiacov.

ČLÁNOK 3 – ODKLADACIE PODMIENKY
3.1 Súhlas PMÚ SR, rakúskeho a maďarského súťažného úradu s koncentráciou;
3.2 rozhodnutie o preverení zahraničnej investície v Rakúsku;
3.3 súhlas odberateľov, ktorí predstavujú viac ako 50 % tržieb, so zmenou kontroly.

ČLÁNOK 4 – ZÁRUKY A ODŠKODNENIE
4.1 Obmedzenie zodpovednosti: 20 % kúpnej ceny [Predávajúci navrhuje 10 %].
4.2 Lehota na uplatnenie nárokov: 18 mesiacov, pri daňových zárukách 5 rokov.

ČLÁNOK 5 – ROZHODNÉ PRÁVO A RIEŠENIE SPOROV
Zmluva sa spravuje slovenským právom. Spory rozhodne rozhodcovský súd podľa Viedenských pravidiel; miestom konania je Viedeň.

[ZVYŠOK PREDMETOM ROKOVANIA]`,

  "Analyza_sutazneho_prava.pdf": `ANALÝZA SÚŤAŽNÉHO PRÁVA
Projekt Dunaj – povinnosti oznámiť koncentráciu

1. PRÍSLUŠNOSŤ EURÓPSKEJ KOMISIE
Celosvetový obrat účastníkov nedosahuje prahy podľa nariadenia (ES) č. 139/2004. Koncentrácia nemá rozmer Spoločenstva a posudzujú ju vnútroštátne orgány.

2. VNÚTROŠTÁTNE OZNÁMENIA
a) Slovensko – PMÚ SR
   Prahy podľa zákona č. 187/2021 Z. z. sú splnené. Oznámenie je povinné pred uskutočnením koncentrácie (zákaz realizácie do rozhodnutia úradu).
b) Rakúsko – Bundeswettbewerbsbehörde
   Prahy sú splnené. Lehota prvej fázy: 4 týždne.
c) Maďarsko – Gazdasági Versenyhivatal
   Prahy sú splnené. Odporúčame predbežné konzultácie.

3. VECNÉ POSÚDENIE
Prekrytie vzniká iba na trhu presných obrábaných dielov pre automobilový priemysel:
- Slovensko: spoločný podiel 17 % (Považské presné diely, a.s. 11 %, DPT Slovakia 6 %)
- Rakúsko: spoločný podiel 9 %
- Maďarsko: spoločný podiel 4 %
Na trhu pôsobia najmenej štyria silní konkurenti a odberatelia majú výraznú vyjednávaciu silu.

4. ZÁVER
Riziko druhej fázy konania hodnotíme ako NÍZKE. Odporúčame podať všetky oznámenia súčasne do 31. 7. 2025.

5. HARMONOGRAM
- 18. 7. 2025: oznámenie PMÚ SR
- 25. 7. 2025: oznámenie v Rakúsku a Maďarsku
- 9/2025: očakávané rozhodnutia
- 10/2025: dokončenie transakcie

Vypracovala: Mgr. Klaudia Novotná, Hrabovský & Partneri`,

  // ws-gdpr-audit
  "Analyza_nedostatkov_GDPR.pdf": `ANALÝZA NEDOSTATKOV V OCHRANE OSOBNÝCH ÚDAJOV
Košická stavebná spoločnosť, s.r.o.

Rozsah: nariadenie (EÚ) 2016/679 (GDPR) a zákon č. 18/2018 Z. z. o ochrane osobných údajov
Obdobie auditu: marec – apríl 2025

ZHRNUTIE
Celková úroveň súladu: 68 % (cieľ: 90 % do konca roka 2025)

1. ZÁZNAMY O SPRACOVATEĽSKÝCH ČINNOSTIACH (čl. 30 GDPR)
Stav: ČIASTOČNÝ SÚLAD
- Záznamy existujú pre 9 z 14 účelov spracúvania
- Chýbajú: dochádzkový systém na stavbách, kamerové systémy, nábor cez sociálne siete

2. PRÁVNY ZÁKLAD (čl. 6 GDPR)
Stav: NEDOSTATOK
- Biometrická dochádzka na 6 stavbách bez posúdenia vplyvu a bez overenia právneho základu
- Súhlas so zasielaním newslettera sa nezaznamenáva

3. ZMLUVY SO SPROSTREDKOVATEĽMI (čl. 28 GDPR)
Stav: ČIASTOČNÝ SÚLAD
- Uzavreté s 5 zo 7 sprostredkovateľov
- Chýba: dodávateľ dochádzkového systému Evidix, s.r.o., správca webového sídla

4. PRÁVA DOTKNUTÝCH OSÔB
Stav: V SÚLADE
- Žiadosti sa vybavujú v priemere do 18 dní

5. ZODPOVEDNÁ OSOBA
Stav: V SÚLADE
- Zodpovedná osoba je určená a oznámená Úradu na ochranu osobných údajov SR

PRIORITNÉ OPATRENIA
  a) Vypracovať posúdenie vplyvu pre biometrickú dochádzku
  b) Uzavrieť zmluvu so sprostredkovateľom s Evidix, s.r.o.
  c) Doplniť záznamy o spracovateľských činnostiach`,

  "Zmluva_o_spracuvani_osobnych_udajov.pdf": `ZMLUVA O SPRACÚVANÍ OSOBNÝCH ÚDAJOV
uzavretá podľa čl. 28 nariadenia (EÚ) 2016/679 a § 34 zákona č. 18/2018 Z. z.

Zmluvné strany:
Prevádzkovateľ: Košická stavebná spoločnosť, s.r.o., IČO: 46213578, Južná trieda 78, 040 01 Košice
Sprostredkovateľ: Evidix, s.r.o., IČO: 52794631, Hlavná 88, 080 01 Prešov

Článok 1 – Predmet a trvanie
Sprostredkovateľ spracúva osobné údaje zamestnancov prevádzkovateľa pri prevádzke dochádzkového systému na stavbách po dobu trvania zmluvy o poskytovaní služieb zo dňa 2. 5. 2025.

Článok 2 – Kategórie údajov a dotknutých osôb
  a) Dotknuté osoby: zamestnanci a pracovníci subdodávateľov na stavbách
  b) Údaje: meno, priezvisko, osobné číslo, čas príchodu a odchodu, číslo stavby
  c) Biometrické údaje sa nespracúvajú bez osobitného písomného pokynu prevádzkovateľa

Článok 3 – Povinnosti sprostredkovateľa
  a) spracúvať osobné údaje len na základe zdokumentovaných pokynov prevádzkovateľa;
  b) zabezpečiť mlčanlivosť osôb, ktoré majú prístup k osobným údajom;
  c) prijať primerané technické a organizačné opatrenia podľa prílohy č. 1;
  d) ďalšieho sprostredkovateľa zapojiť len s predchádzajúcim písomným súhlasom prevádzkovateľa;
  e) oznámiť porušenie ochrany osobných údajov bez zbytočného odkladu, najneskôr do 24 hodín.

Článok 4 – Prenos do tretích krajín
Údaje sa uchovávajú výlučne v dátových centrách v Európskej únii.

Článok 5 – Skončenie spracúvania
Po skončení poskytovania služieb sprostredkovateľ osobné údaje vymaže alebo vráti prevádzkovateľovi podľa jeho voľby.

V Košiciach dňa 15. 5. 2025`,

  "Posudenie_vplyvu_DPIA.docx": `POSÚDENIE VPLYVU NA OCHRANU OSOBNÝCH ÚDAJOV (DPIA)
podľa čl. 35 nariadenia (EÚ) 2016/679 a § 42 zákona č. 18/2018 Z. z.

Prevádzkovateľ: Košická stavebná spoločnosť, s.r.o.
Spracovateľská operácia: biometrická evidencia dochádzky na stavbách (odtlačok prsta)

1. OPIS SPRACÚVANIA
Terminály na 6 stavbách snímajú odtlačok prsta, z ktorého sa vytvára šablóna uložená v systéme Evidix. Dotknutých je približne 420 zamestnancov a pracovníkov subdodávateľov.

2. NEVYHNUTNOSŤ A PRIMERANOSŤ
Biometrické údaje patria medzi osobitné kategórie osobných údajov (čl. 9 GDPR). Zamestnávateľ ich môže spracúvať iba v rozsahu, ktorý pripúšťa § 78 ods. 4 zákona č. 18/2018 Z. z. Účel, evidencia pracovného času, možno dosiahnuť aj čipovými kartami.

3. RIZIKÁ
  a) únik biometrických šablón – dopad VYSOKÝ, pravdepodobnosť NÍZKA
  b) súhlas zamestnancov nie je slobodný pre závislé postavenie – VYSOKÉ riziko
  c) uchovávanie údajov po skončení pracovného pomeru – STREDNÉ riziko

4. OPATRENIA
  a) nahradiť odtlačok prsta čipovými kartami na stavbách bez osobitného bezpečnostného režimu;
  b) biometriu ponechať iba pri vstupe do skladu výbušnín, s alternatívou pre zamestnancov;
  c) šablóny vymazať do 30 dní od skončenia pracovného pomeru.

5. ZÁVER
Po prijatí opatrení je zostatkové riziko PRIJATEĽNÉ. Predchádzajúca konzultácia s Úradom na ochranu osobných údajov SR nie je potrebná.

Stanovisko zodpovednej osoby: súhlasí s podmienkou zavedenia opatrení do 30. 9. 2025.`,

  "Zasady_cookies_navrh.pdf": `ZÁSADY POUŽÍVANIA SÚBOROV COOKIES – NÁVRH
Košická stavebná spoločnosť, s.r.o. – webové sídlo

1. ČO SÚ COOKIES
Cookies sú malé textové súbory, ktoré sa ukladajú do Vášho zariadenia pri návšteve webového sídla. Ich používanie upravuje § 109 ods. 8 zákona č. 452/2021 Z. z. o elektronických komunikáciách a nariadenie (EÚ) 2016/679.

2. KATEGÓRIE COOKIES
  a) Nevyhnutné – zabezpečujú fungovanie webu (prihlásenie do klientskej zóny, bezpečnosť). Nevyžadujú súhlas.
  b) Analytické – merajú návštevnosť a správanie návštevníkov. Používame ich len s Vaším súhlasom.
  c) Marketingové – umožňujú zobrazovať reklamu na iných weboch. Používame ich len s Vaším súhlasom.

3. PREHĽAD COOKIES
  - session_id – nevyhnutné, do zatvorenia prehliadača
  - cookie_consent – nevyhnutné, 12 mesiacov
  - _analytics_id – analytické, 13 mesiacov
  - _ads_click – marketingové, 90 dní

4. SÚHLAS A JEHO ODVOLANIE
Súhlas udeľujete v lište pri prvej návšteve. Tlačidlá „Prijať všetko“ a „Odmietnuť všetko“ sú rovnako výrazné. Súhlas môžete kedykoľvek odvolať cez odkaz „Nastavenia cookies“ v päte stránky.

5. KONTAKT
Otázky k spracúvaniu osobných údajov adresujte zodpovednej osobe na gdpr@kosicka-stavebna.example.

[NÁVRH – na pripomienkovanie marketingovým oddelením do 30. 6. 2025]`,
};
