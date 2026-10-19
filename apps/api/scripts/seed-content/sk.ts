// The Slovak marketing firm, Hrabovský & Partneri (Bratislava): Slovak
// clients, matters, billing and fixture AI answers for the sk capture set.
// The document bodies and emails live in ./sk-documents; this pack writes
// everything else.
import { MARKETING_LOCALE_MARKERS } from "@stll/playwright-tools/marketing-locales";

import { seedId } from "../seed-utils";
import {
  SK_DOCUMENT_TEXTS,
  SK_EMAILS,
  SK_MATTER_DOCUMENTS,
  SK_SPA_DOCUMENT_NAME,
} from "./sk-documents";
import {
  supplierAgreementBody as body,
  supplierAgreementHeading as heading,
} from "./types";
import type {
  SeedLocaleContent,
  SeedOrganizationContact,
  SupplierAgreementParagraph,
} from "./types";

const MARKERS = MARKETING_LOCALE_MARKERS.sk;

// Reviewer identity stamped on the tracked changes and margin comments;
// Klaudia Novotná is the firm's third seeded colleague.
const SUPPLIER_AGREEMENT_REVIEWER = {
  author: "Klaudia Novotná",
  date: "2026-07-16T09:30:00Z",
  initials: "KN",
};

const SUPPLIER_AGREEMENT_COMMENTS = [
  {
    id: 1,
    text:
      "Nad schváleným limitom: Playbook nákupných zmlúv pripúšťa obmedzenie " +
      "predvídateľnej škody najviac do 100 % ročného objemu plnenia. " +
      "Upravené na pozíciu podľa playbooku; potrebné schválenie partnerom.",
  },
  {
    id: 2,
    text:
      "Playbook nákupných zmlúv vyžaduje pri zmluvách kritických pre " +
      "dodávky výpovednú lehotu najmenej deväťdesiat (90) dní. Druhá " +
      "odchýlka od playbooku, označená na posúdenie.",
  },
];

const SUPPLIER_AGREEMENT_PARAGRAPHS: readonly SupplierAgreementParagraph[] = [
  { runs: [{ kind: "text", text: "Zmluva o dodávkach" }], style: "title" },
  body("PRACOVNÁ VERZIA v4 — OBSAHUJE SLEDOVANÉ ZMENY"),
  body(
    "uzavretá dňa 1. 7. 2026 podľa § 409 a nasl. zákona č. 513/1991 Zb. " +
      "Obchodný zákonník v znení neskorších predpisov (ďalej len „Zmluva“) " +
      "medzi týmito zmluvnými stranami:",
  ),
  body(
    "(1) Severka Robotics, a.s., so sídlom Kamenná 14, 010 01 Žilina, " +
      "Slovenská republika, IČO: 51 284 736, zapísaná v obchodnom registri, " +
      "oddiel: Sa, vložka č. 11284/L (ďalej len „Kupujúci“); a",
  ),
  body(
    "(2) Meridian Precision Components GmbH, spoločnosť založená podľa " +
      "práva Spolkovej republiky Nemecko, so sídlom Werkstraße 12, 80339 " +
      "Mníchov, Nemecko, zapísaná v obchodnom registri Okresného súdu " +
      "Mníchov pod č. HRB 248113 (ďalej len „Predávajúci“),",
  ),
  body(
    "Kupujúci a Predávajúci ďalej spolu ako „zmluvné strany“ a každý " +
      "samostatne ako „zmluvná strana“.",
  ),
  body(
    "Kupujúci vyvíja a vyrába autonómne mobilné roboty a potrebuje " +
      "spoľahlivé dodávky presných komponentov pohonov. Predávajúci vyrába " +
      "harmonické prevodovky, puzdrá aktuátorov a súvisiace komponenty " +
      "zodpovedajúce Špecifikácii. Zmluvné strany sa preto dohodli takto:",
  ),
  heading("Článok 1 – Vymedzenie pojmov a výklad"),
  body(
    "1.1 Na účely tejto Zmluvy: „prepojená osoba“ je osoba, ktorá priamo " +
      "alebo nepriamo ovláda zmluvnú stranu, je ňou ovládaná alebo je s ňou " +
      "pod spoločným ovládaním; „ročný objem plnenia“ je súhrn kúpnych cien " +
      "zaplatených alebo splatných Kupujúcim podľa tejto Zmluvy za dvanásť " +
      "(12) mesiacov bezprostredne predchádzajúcich udalosti, ktorá zakladá " +
      "príslušný nárok; „pracovný deň“ je deň okrem soboty, nedele a dňa " +
      "pracovného pokoja v Slovenskej republike alebo v Bavorsku; " +
      "„Objednávka“ je objednávka Kupujúceho podľa článku 3; „Tovar“ sú " +
      "komponenty uvedené v prílohe č. 1; a „Špecifikácia“ je technická " +
      "špecifikácia uvedená v prílohe č. 1 v znení zmien podľa bodu 2.3.",
  ),
  body(
    "1.2 Nadpisy článkov slúžia len na prehľadnosť a nemajú vplyv na výklad " +
      "Zmluvy. Odkazy na články a prílohy sú odkazmi na články a prílohy " +
      "tejto Zmluvy.",
  ),
  heading("Článok 2 – Predmet Zmluvy"),
  body(
    "2.1 Predávajúci sa zaväzuje vyrábať a dodávať Kupujúcemu Tovar v " +
      "súlade so Špecifikáciou, dohodnutými akostnými normami a touto " +
      "Zmluvou a previesť na neho vlastnícke právo k Tovaru; Kupujúci sa " +
      "zaväzuje Tovar prevziať a zaplatiť zaň kúpnu cenu.",
  ),
  body(
    "2.2 Predávajúci udržiava výrobnú kapacitu dostatočnú na pokrytie " +
      "plánu odberov Kupujúceho, a to až do výšky stodvadsiatich percent " +
      "(120 %) objemu podľa posledného štvrťročného plánu.",
  ),
  body(
    "2.3 Žiadna zo zmluvných strán nesmie zmeniť Špecifikáciu bez " +
      "predchádzajúceho písomného súhlasu druhej zmluvnej strany. " +
      "Predávajúci oznámi Kupujúcemu ukončenie výroby ktoréhokoľvek druhu " +
      "Tovaru písomne najmenej dvanásť (12) mesiacov vopred.",
  ),
  heading("Článok 3 – Plán odberov a objednávky"),
  body(
    "3.1 Kupujúci predkladá kĺzavý plán odberov na dvanásť (12) mesiacov, " +
      "ktorý mesačne aktualizuje. Prvé tri (3) mesiace každého plánu sú pre " +
      "Kupujúceho záväzné.",
  ),
  body(
    "3.2 Kupujúci objednáva Tovar Objednávkou, v ktorej uvedie množstvo, " +
      "termíny a miesta dodania. Predávajúci Objednávku prijme alebo " +
      "odmietne do piatich (5) pracovných dní; Objednávka, ktorú v tejto " +
      "lehote neodmietne, sa považuje za prijatú.",
  ),
  body(
    "3.3 Kupujúci môže prijatú Objednávku bezplatne zrušiť alebo zmeniť " +
      "termín jej dodania, ak tak urobí viac ako šesťdesiat (60) dní pred " +
      "dohodnutým termínom dodania.",
  ),
  heading("Článok 4 – Dodanie, vlastnícke právo a nebezpečenstvo škody"),
  body(
    "4.1 Predávajúci dodá Tovar s dodacou paritou DAP (Incoterms® 2020) do " +
      "prevádzky Kupujúceho uvedenej v Objednávke. Dodržanie termínov " +
      "dodania je pre Kupujúceho podstatné.",
  ),
  body(
    "4.2 Ak Predávajúci nedodá Tovar v potvrdenom termíne, je povinný " +
      "zaplatiť Kupujúcemu zmluvnú pokutu vo výške 0,5 % z hodnoty " +
      "Objednávky za každý začatý týždeň omeškania, najviac však 5 % z " +
      "hodnoty Objednávky.",
  ),
  body(
    "4.3 Vlastnícke právo k Tovaru a nebezpečenstvo škody na ňom " +
      "prechádzajú na Kupujúceho riadnym dodaním podľa bodu 4.1.",
  ),
  heading("Článok 5 – Kúpna cena a platobné podmienky"),
  body(
    "5.1 Kúpne ceny sú uvedené v prílohe č. 2 a sú pevné do 31. 12. 2026. " +
      "Neskoršia zmena cien si vyžaduje písomné oznámenie najmenej " +
      "deväťdesiat (90) dní vopred a písomný súhlas Kupujúceho.",
  ),
  body(
    "5.2 Predávajúci fakturuje mesačne pozadu. Nesporné faktúry sú " +
      "splatné do štyridsaťpäť (45) dní od doručenia riadnej faktúry.",
  ),
  body(
    "5.3 Zmluvné strany raz ročne v dobrej viere prerokujú ceny s cieľom " +
      "dosiahnuť zvýšenie produktivity o dve percentá (2 %) ročne.",
  ),
  heading("Článok 6 – Akosť, vstupná kontrola a vady Tovaru"),
  body(
    "6.1 Predávajúci udržiava systém manažérstva kvality certifikovaný " +
      "podľa ISO 9001 (alebo rovnocenný) a uchováva záznamy o kvalite " +
      "každej výrobnej dávky Tovaru najmenej desať (10) rokov.",
  ),
  body(
    "6.2 Kupujúci môže vykonať vstupnú kontrolu do desiatich (10) " +
      "pracovných dní od dodania. Odmietnutie vadného Tovaru v tejto lehote " +
      "neobmedzuje práva Kupujúceho zo záruky za akosť.",
  ),
  body(
    "6.3 Pri vadnom Tovare Predávajúci podľa voľby Kupujúceho Tovar " +
      "vymení alebo vráti kúpnu cenu, v oboch prípadoch do desiatich (10) " +
      "pracovných dní od oznámenia vady.",
  ),
  heading("Článok 7 – Záruka za akosť"),
  body(
    "7.1 Predávajúci preberá záruku za akosť v trvaní dvadsaťštyri (24) " +
      "mesiacov od dodania, že Tovar zodpovedá Špecifikácii, nemá vady " +
      "materiálu ani spracovania a je v súlade s právnymi predpismi.",
  ),
  body(
    "7.2 Nároky podľa bodu 6.3 sa uplatnia pri každom porušení záruky " +
      "podľa bodu 7.1; tým nie sú dotknuté ostatné práva Kupujúceho podľa " +
      "tejto Zmluvy.",
  ),
  heading("Článok 8 – Duševné vlastníctvo"),
  body(
    "8.1 Každá zmluvná strana si ponecháva všetky práva k duševnému " +
      "vlastníctvu, ktoré mala pred uzavretím Zmluvy. Náradie, konštrukčné " +
      "návrhy a Špecifikácia poskytnuté Kupujúcim zostávajú vo vlastníctve " +
      "Kupujúceho a Predávajúci ich smie použiť výlučne na plnenie tejto " +
      "Zmluvy.",
  ),
  heading("Článok 9 – Mlčanlivosť"),
  body(
    "9.1 Každá zmluvná strana zachováva mlčanlivosť o dôverných " +
      "informáciách a obchodnom tajomstve druhej zmluvnej strany, použije " +
      "ich výlučne na plnenie tejto Zmluvy a sprístupní ich len " +
      "zamestnancom a poradcom, ktorí ich potrebujú a sú viazaní " +
      "rovnocennou povinnosťou mlčanlivosti. Tento článok zostáva účinný " +
      "päť (5) rokov po skončení Zmluvy.",
  ),
  heading("Článok 10 – Ochrana osobných údajov a bezpečnosť"),
  body(
    "10.1 Zmluvné strany pri plnení tejto Zmluvy dodržiavajú nariadenie " +
      "(EÚ) 2016/679 (GDPR) a zákon č. 18/2018 Z. z. o ochrane osobných " +
      "údajov a prijmú primerané technické a organizačné opatrenia na " +
      "ochranu osobných údajov, ktoré spracúvajú pre druhú zmluvnú stranu.",
  ),
  heading("Článok 11 – Poistenie"),
  body(
    "11.1 Predávajúci je povinný mať u renomovanej poisťovne uzavreté " +
      "poistenie zodpovednosti za škodu spôsobenú vadným výrobkom s limitom " +
      "plnenia najmenej 5 000 000 eur na jednu poistnú udalosť a na " +
      "požiadanie predložiť poistný certifikát.",
  ),
  heading("Článok 12 – Obmedzenie náhrady škody"),
  body(
    "12.1 Obmedzenia podľa tohto článku sa nevzťahujú na škodu spôsobenú " +
      "úmyselne alebo z hrubej nedbanlivosti, na ujmu na živote alebo " +
      "zdraví ani na inú zodpovednosť, ktorú podľa právnych predpisov " +
      "nemožno vylúčiť ani obmedziť. Každá zmluvná strana naďalej zodpovedá " +
      "za plnenie svojich povinností podľa tejto Zmluvy.",
  ),
  {
    commentId: 1,
    runs: [
      {
        kind: "text",
        text:
          "12.2 Zmluvné strany v súlade s § 379 Obchodného zákonníka " +
          "vyhlasujú, že celková predvídateľná škoda, ktorú môže " +
          "Predávajúci spôsobiť porušením svojich povinností, nepresiahne ",
      },
      { kind: "deleted", text: "300 % ceny" },
      { kind: "inserted", text: "100 % ročného objemu plnenia" },
      { kind: "text", text: " podľa tejto Zmluvy." },
    ],
    style: "body",
  },
  body(
    "12.3 Žiadna zo zmluvných strán nezodpovedá za ušlý zisk, stratu " +
      "výnosov, stratu údajov ani za akúkoľvek nepriamu alebo následnú " +
      "škodu bez ohľadu na jej príčinu.",
  ),
  body("12.4 Ustanovenia tohto článku zostávajú účinné aj po skončení Zmluvy."),
  heading("Článok 13 – Nároky tretích osôb"),
  body(
    "13.1 Predávajúci nahradí Kupujúcemu všetku ujmu z nárokov tretích " +
      "osôb, podľa ktorých dodaný Tovar porušuje práva duševného " +
      "vlastníctva, ak Kupujúci Predávajúcemu takýto nárok bez zbytočného " +
      "odkladu oznámi a prenechá mu vedenie obrany.",
  ),
  heading("Článok 14 – Doba trvania a skončenie Zmluvy"),
  {
    commentId: 2,
    runs: [
      {
        kind: "text",
        text:
          "14.1 Táto Zmluva nadobúda platnosť a účinnosť dňom 1. 7. 2026 " +
          "a uzatvára sa na dobu troch (3) rokov; jej trvanie sa " +
          "automaticky predlžuje vždy o ďalší jeden (1) rok. Každá zmluvná " +
          "strana môže túto Zmluvu vypovedať aj bez uvedenia dôvodu " +
          "písomnou výpoveďou s výpovednou lehotou tridsať (30) dní, ktorá " +
          "začína plynúť dňom doručenia výpovede druhej zmluvnej strane.",
      },
    ],
    style: "body",
  },
  body(
    "14.2 Každá zmluvná strana môže od tejto Zmluvy písomne odstúpiť s " +
      "účinnosťou ku dňu doručenia odstúpenia, ak u druhej zmluvnej strany " +
      "dôjde k zmene kontroly bez jej predchádzajúceho písomného súhlasu, " +
      "ak na majetok druhej zmluvnej strany bol vyhlásený konkurz alebo " +
      "povolená reštrukturalizácia, alebo ak druhá zmluvná strana podstatne " +
      "poruší Zmluvu a porušenie neodstráni do tridsiatich (30) dní od " +
      "doručenia písomnej výzvy.",
  ),
  body(
    "14.3 Skončením Zmluvy nie sú dotknuté už vzniknuté práva. Po skončení " +
      "Zmluvy Predávajúci vráti Kupujúcemu jeho náradie, konštrukčné návrhy " +
      "a dôverné informácie a počas najviac šiestich (6) mesiacov poskytne " +
      "súčinnosť pri plynulom prechode dodávok.",
  ),
  heading("Článok 15 – Okolnosti vylučujúce zodpovednosť"),
  body(
    "15.1 Žiadna zo zmluvných strán nezodpovedá za omeškanie ani " +
      "nesplnenie povinnosti spôsobené okolnosťami vylučujúcimi " +
      "zodpovednosť podľa § 374 Obchodného zákonníka, ak ich druhej " +
      "zmluvnej strane bez zbytočného odkladu oznámi a vynaloží primerané " +
      "úsilie na zmiernenie ich následkov. Ak takéto okolnosti trvajú dlhšie " +
      "ako šesťdesiat (60) dní, môže ktorákoľvek zmluvná strana od " +
      "dotknutých Objednávok odstúpiť.",
  ),
  heading("Článok 16 – Záverečné ustanovenia"),
  body(
    "16.1 Táto Zmluva sa spravuje právnym poriadkom Slovenskej republiky, " +
      "najmä Obchodným zákonníkom; použitie Dohovoru OSN o zmluvách o " +
      "medzinárodnej kúpe tovaru sa vylučuje. Na rozhodovanie sporov z tejto " +
      "Zmluvy sú príslušné súdy Slovenskej republiky; miestne príslušným " +
      "súdom prvého stupňa je Okresný súd Žilina.",
  ),
  body(
    "16.2 Táto Zmluva vrátane jej príloh predstavuje úplnú dohodu " +
      "zmluvných strán o jej predmete. Zmeny Zmluvy sú možné len formou " +
      "písomných dodatkov podpísaných oboma zmluvnými stranami. Oznámenia " +
      "sa doručujú písomne na adresy uvedené v záhlaví Zmluvy.",
  ),
  body(
    "16.3 Zmluva je vyhotovená v dvoch rovnopisoch v slovenskom a nemeckom " +
      "jazyku; v prípade rozporu má prednosť slovenské znenie.",
  ),
  body("Za Severka Robotics, a.s.:"),
  body("Ing. Tomáš Rybár, predseda predstavenstva"),
  body("Za Meridian Precision Components GmbH:"),
  body("Katrin Vogel, konateľka"),
];

const ORG_CONTACTS: SeedLocaleContent["orgContacts"] = [
  {
    id: seedId("contact-org-strojarne-liptov"),
    type: "organization",
    displayName: "Strojárne Liptov, a.s.",
    organizationName: "Strojárne Liptov, a.s.",
    registrationNumber: "36412881",
    taxId: "SK2020184563",
    bankAccounts: [
      {
        iban: "SK6609000000005012345678",
        bic: "GIBASKBX",
        bankName: "Slovenská sporiteľňa",
        currency: "EUR",
      },
    ],
    billingAddress: {
      line1: "Priemyselná 2",
      city: "Liptovský Mikuláš",
      postalCode: "031 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 190,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "pravne@strojarne-liptov.sk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office",
        number: "+421 44 552 3100",
        isPrimary: true,
      },
    ],
    notes: "DIČ: 2020184563",
    color: "blue",
  },
  {
    id: seedId("contact-org-hronska-energetika"),
    type: "organization",
    displayName: "Hronská energetika, a.s.",
    organizationName: "Hronská energetika, a.s.",
    registrationNumber: "36785412",
    taxId: "SK2022417785",
    bankAccounts: [
      {
        iban: "SK1102000000002914785632",
        bic: "SUBASKBX",
        bankName: "Všeobecná úverová banka",
        currency: "EUR",
      },
      {
        iban: "CZ1803000000000217543119",
        bic: "CEKOCZPP",
        bankName: "ČSOB",
        currency: "CZK",
      },
    ],
    billingAddress: {
      line1: "Mlynské nivy 48",
      city: "Bratislava",
      state: "Bratislava II",
      postalCode: "821 09",
      country: "Slovensko",
    },
    defaultHourlyRate: 220,
    currency: "EUR",
    paymentTermDays: 14,
    emails: [
      {
        type: "work",
        address: "legal@hronska-energetika.sk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office",
        number: "+421 2 5824 1100",
        isPrimary: true,
      },
    ],
    notes: "DIČ: 2022417785",
    color: "green",
  },
  {
    id: seedId("contact-org-kosicka-stavebna"),
    type: "organization",
    displayName: "Košická stavebná spoločnosť, s.r.o.",
    organizationName: "Košická stavebná spoločnosť, s.r.o.",
    registrationNumber: "46213578",
    taxId: "SK2023298114",
    bankAccounts: [
      {
        iban: "SK1775000000004011229876",
        bic: "CEKOSKBX",
        bankName: "ČSOB",
        currency: "EUR",
      },
    ],
    billingAddress: {
      line1: "Južná trieda 78",
      city: "Košice",
      postalCode: "040 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 160,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "kancelaria@kosicka-stavebna.sk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office",
        number: "+421 55 622 4870",
        isPrimary: true,
      },
    ],
    notes: "DIČ: 2023298114",
    color: "orange",
  },
  {
    id: seedId("contact-org-tatra-horizon"),
    type: "organization",
    displayName: "Tatra Horizon Capital, a.s.",
    organizationName: "Tatra Horizon Capital, a.s.",
    registrationNumber: "51936274",
    taxId: "SK2120847391",
    bankAccounts: [
      {
        iban: "SK7856000000008814203317",
        bic: "KOMASK2X",
        bankName: "Prima banka Slovensko",
        currency: "EUR",
      },
    ],
    billingAddress: {
      line1: "Karadžičova 8",
      city: "Bratislava",
      state: "Bratislava II",
      postalCode: "821 08",
      country: "Slovensko",
    },
    defaultHourlyRate: 250,
    currency: "EUR",
    paymentTermDays: 45,
    emails: [
      {
        type: "work",
        address: "legal@tatrahorizon.sk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office",
        number: "+421 2 3301 7700",
        isPrimary: true,
      },
    ],
    notes: "DIČ: 2120847391",
    color: "emerald",
  },
  {
    id: seedId("contact-org-severka-robotics"),
    type: "organization",
    displayName: "Severka Robotics, a.s.",
    organizationName: "Severka Robotics, a.s.",
    registrationNumber: "51284736",
    taxId: "SK2120639475",
    bankAccounts: [
      {
        iban: "SK2211110000006612003456",
        bic: "UNCRSKBX",
        bankName: "UniCredit Bank",
        currency: "EUR",
      },
    ],
    billingAddress: {
      line1: "Kamenná 14",
      city: "Žilina",
      postalCode: "010 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 210,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "legal@severka-robotics.sk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office",
        number: "+421 41 507 2200",
        isPrimary: true,
      },
    ],
    notes: "DIČ: 2120639475",
    color: "violet",
  },
];

// Further clients for a realistic contacts list. The contacts list sorts by
// display name, and the capture expects the marker law firm on top: no other
// name may start with digits or with "Aa"–"Ad".
const MORE_ORG_CONTACTS: readonly SeedOrganizationContact[] = [
  {
    id: seedId("contact-org-bednar-kollar"),
    type: "organization",
    displayName: MARKERS.firstContactName,
    organizationName: MARKERS.firstContactName,
    registrationNumber: "47561239",
    taxId: "SK2024013586",
    billingAddress: {
      line1: "Panská 14",
      city: "Bratislava",
      postalCode: "811 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 200,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "office@bednar-kollar.sk",
        isPrimary: true,
      },
    ],
    color: "indigo",
  },
  {
    id: seedId("contact-org-hoch-lindner"),
    type: "organization",
    displayName: "Hoch & Lindner Rechtsanwälte GmbH",
    organizationName: "Hoch & Lindner Rechtsanwälte GmbH",
    registrationNumber: "FN 412345 a",
    taxId: "ATU71234567",
    billingAddress: {
      line1: "Schottenring 12",
      city: "Wien",
      postalCode: "1010",
      country: "Rakúsko",
    },
    defaultHourlyRate: 350,
    currency: "EUR",
    paymentTermDays: 21,
    emails: [
      {
        type: "work",
        address: "kanzlei@hoch-lindner.at",
        isPrimary: true,
      },
    ],
    color: "rose",
  },
  {
    id: seedId("contact-org-oceliaren-povazie"),
    type: "organization",
    displayName: "Oceliareň Považie, a.s.",
    organizationName: "Oceliareň Považie, a.s.",
    registrationNumber: "36318742",
    taxId: "SK2020071942",
    billingAddress: {
      line1: "Priemyselná 12",
      city: "Považská Bystrica",
      postalCode: "017 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 180,
    currency: "EUR",
    paymentTermDays: 45,
    emails: [
      {
        type: "work",
        address: "pravne@oceliaren-povazie.sk",
        isPrimary: true,
      },
    ],
    color: "slate",
  },
  {
    id: seedId("contact-org-pannon-agrar"),
    type: "organization",
    displayName: "Pannon Agrár Kft.",
    organizationName: "Pannon Agrár Kft.",
    registrationNumber: "08-09-028417",
    taxId: "HU24817365",
    billingAddress: {
      line1: "Bajcsy-Zsilinszky út 21",
      city: "Győr",
      postalCode: "9021",
      country: "Maďarsko",
    },
    defaultHourlyRate: 170,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "jog@pannon-agrar.hu",
        isPrimary: true,
      },
    ],
    color: "lime",
  },
  {
    id: seedId("contact-org-medika-danubia"),
    type: "organization",
    displayName: "Medika Danubia, s.r.o.",
    organizationName: "Medika Danubia, s.r.o.",
    registrationNumber: "50127783",
    taxId: "SK2120198647",
    billingAddress: {
      line1: "Záhradnícka 46",
      city: "Bratislava",
      postalCode: "821 08",
      country: "Slovensko",
    },
    defaultHourlyRate: 220,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "legal@medika-danubia.sk",
        isPrimary: true,
      },
    ],
    color: "pink",
  },
  {
    id: seedId("contact-org-vltavin-software"),
    type: "organization",
    displayName: "Vltavín Software a.s.",
    organizationName: "Vltavín Software a.s.",
    registrationNumber: "28471953",
    taxId: "CZ28471953",
    billingAddress: {
      line1: "Na Poříčí 1041/12",
      city: "Praha",
      postalCode: "110 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 4200,
    currency: "CZK",
    paymentTermDays: 14,
    emails: [
      {
        type: "work",
        address: "pravni@vltavin-software.cz",
        isPrimary: true,
      },
    ],
    color: "yellow",
  },
  {
    id: seedId("contact-org-morava-logistik"),
    type: "organization",
    displayName: "Morava Logistik s.r.o.",
    organizationName: "Morava Logistik s.r.o.",
    registrationNumber: "06138247",
    taxId: "CZ06138247",
    billingAddress: {
      line1: "Nádražní 88",
      city: "Ostrava",
      postalCode: "702 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 3800,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "office@morava-logistik.cz",
        isPrimary: true,
      },
    ],
    color: "stone",
  },
  {
    id: seedId("contact-org-murtal-bau"),
    type: "organization",
    displayName: "Murtal Bau GmbH",
    organizationName: "Murtal Bau GmbH",
    registrationNumber: "FN 298765 k",
    taxId: "ATU65432198",
    billingAddress: {
      line1: "Annenstraße 40",
      city: "Graz",
      postalCode: "8020",
      country: "Rakúsko",
    },
    defaultHourlyRate: 300,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "recht@murtal-bau.at",
        isPrimary: true,
      },
    ],
    color: "red",
  },
  {
    id: seedId("contact-org-vychodna-tech"),
    type: "organization",
    displayName: "Východná Tech Ventures, s.r.o.",
    organizationName: "Východná Tech Ventures, s.r.o.",
    registrationNumber: "53648215",
    taxId: "SK2121437860",
    billingAddress: {
      line1: "Hlavná 32",
      city: "Košice",
      postalCode: "040 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 190,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "office@vychodna-tech.sk",
        isPrimary: true,
      },
    ],
    color: "zinc",
  },
  {
    id: seedId("contact-org-orava-drevo"),
    type: "organization",
    displayName: "Orava Drevo, s.r.o.",
    organizationName: "Orava Drevo, s.r.o.",
    registrationNumber: "44781236",
    taxId: "SK2022853017",
    billingAddress: {
      line1: "Hviezdoslavovo námestie 5",
      city: "Námestovo",
      postalCode: "029 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 150,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "obchod@orava-drevo.sk",
        isPrimary: true,
      },
    ],
    color: "teal",
  },
  {
    id: seedId("contact-org-dunajsky-pristav"),
    type: "organization",
    displayName: "Dunajský prístav Komárno, a.s.",
    organizationName: "Dunajský prístav Komárno, a.s.",
    registrationNumber: "31445678",
    taxId: "SK2020396514",
    billingAddress: {
      line1: "Lodná 2",
      city: "Komárno",
      postalCode: "945 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 170,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "pravne@pristav-komarno.sk",
        isPrimary: true,
      },
    ],
    color: "purple",
  },
  {
    id: seedId("contact-org-zemplin-agro"),
    type: "organization",
    displayName: "Zemplín Agro, s.r.o.",
    organizationName: "Zemplín Agro, s.r.o.",
    registrationNumber: "46987321",
    taxId: "SK2023671248",
    billingAddress: {
      line1: "Kpt. Nálepku 9",
      city: "Michalovce",
      postalCode: "071 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 150,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "info@zemplin-agro.sk",
        isPrimary: true,
      },
    ],
    color: "cyan",
  },
];

const PERSON_CONTACTS: SeedLocaleContent["personContacts"] = [
  {
    id: seedId("contact-person-martin-kollar"),
    type: "person",
    displayName: "JUDr. Martin Kollár",
    prefix: "JUDr.",
    firstName: "Martin",
    lastName: "Kollár",
    emails: [
      {
        type: "work",
        address: "martin.kollar@bednar-kollar.sk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile",
        number: "+421 905 214 377",
        isPrimary: true,
      },
    ],
    color: "violet",
  },
  {
    id: seedId("contact-person-zuzana-simkova"),
    type: "person",
    displayName: "Mgr. Zuzana Šimková",
    prefix: "Mgr.",
    firstName: "Zuzana",
    lastName: "Šimková",
    emails: [
      {
        type: "work",
        address: "zuzana.simkova@hronska-energetika.sk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile",
        number: "+421 917 482 105",
        isPrimary: true,
      },
    ],
    color: "fuchsia",
  },
  {
    id: seedId("contact-person-peter-balaz"),
    type: "person",
    displayName: "Ing. Peter Baláž",
    prefix: "Ing.",
    firstName: "Peter",
    lastName: "Baláž",
    emails: [
      {
        type: "work",
        address: "balaz@kosicka-stavebna.sk",
        isPrimary: true,
      },
    ],
    color: "cyan",
  },
  {
    id: seedId("contact-person-hannah-whitcombe"),
    type: "person",
    displayName: "Hannah Whitcombe",
    firstName: "Hannah",
    lastName: "Whitcombe",
    emails: [
      {
        type: "work",
        address: "hannah.whitcombe@tatrahorizon.sk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile",
        number: "+44 7700 900456",
        isPrimary: true,
      },
    ],
    color: "sky",
  },
  {
    id: seedId("contact-person-lubomir-drab"),
    type: "person",
    displayName: "JUDr. Ľubomír Dráb, PhD.",
    prefix: "JUDr.",
    firstName: "Ľubomír",
    lastName: "Dráb",
    suffix: "PhD.",
    notes: "Odborník na stavebné právo",
    emails: [
      {
        type: "work",
        address: "drab@drab-advokat.sk",
        isPrimary: true,
      },
    ],
    color: "amber",
  },
];

const EXTRA_MATTERS = [
  // Advokátska kancelária Bednár & Kollár
  {
    name: "Rozhodcovské konanie – dodávky technológií",
    reference: "2024/009",
    clientLabel: "contact-org-bednar-kollar",
  },
  {
    name: "Prevod obchodného podielu – Nitra",
    reference: "2024/010",
    clientLabel: "contact-org-bednar-kollar",
  },
  // Hoch & Lindner
  {
    name: "Spor spoločníkov – Viedeň",
    reference: "2024/011",
    clientLabel: "contact-org-hoch-lindner",
  },
  // Oceliareň Považie
  {
    name: "Integrované povolenie – zmena prevádzky",
    reference: "2024/012",
    clientLabel: "contact-org-oceliaren-povazie",
  },
  {
    name: "Kolektívna zmluva 2026",
    reference: "2024/013",
    clientLabel: "contact-org-oceliaren-povazie",
  },
  {
    name: "Cezhraničná dodávka ocele",
    reference: "2024/014",
    clientLabel: "contact-org-oceliaren-povazie",
  },
  // Medika Danubia
  {
    name: "Registrácia liekov – ŠÚKL",
    reference: "2024/015",
    clientLabel: "contact-org-medika-danubia",
  },
  {
    name: "Zmluvy o klinickom skúšaní",
    reference: "2024/016",
    clientLabel: "contact-org-medika-danubia",
  },
  // Vltavín Software
  {
    name: "Licenčná zmluva na softvér",
    reference: "2024/017",
    clientLabel: "contact-org-vltavin-software",
  },
  {
    name: "Integrácia po akvizícii",
    reference: "2024/018",
    clientLabel: "contact-org-vltavin-software",
  },
  // Východná Tech Ventures
  {
    name: "Investičné kolo – term sheet",
    reference: "2024/019",
    clientLabel: "contact-org-vychodna-tech",
  },
  {
    name: "Zamestnanecký opčný program",
    reference: "2024/020",
    clientLabel: "contact-org-vychodna-tech",
  },
  // Dunajský prístav Komárno
  {
    name: "Nájom prístavných pozemkov",
    reference: "2024/021",
    clientLabel: "contact-org-dunajsky-pristav",
  },
  // Morava Logistik
  {
    name: "Náhrada škody – poškodená zásielka",
    reference: "2024/022",
    clientLabel: "contact-org-morava-logistik",
  },
  // Extra matters for the main clients (deeper grouping)
  {
    name: "Stavebné povolenie – Košice-Juh",
    reference: "2024/057",
    clientLabel: "contact-org-kosicka-stavebna",
  },
  {
    name: "Štruktúrovanie Fondu IV",
    reference: "2024/058",
    clientLabel: "contact-org-tatra-horizon",
  },
];

const RECENT_MATTER_ACTIVITY = {
  "2024/059": "2026-07-17T09:00:00.000Z", // Preverenie dátovej miestnosti – Projekt Atlas (Tatra Horizon)
  "2026/031": "2026-07-16T15:00:00.000Z", // Zmluva o dodávkach – Meridian (Severka Robotics)
  "2024/058": "2026-07-16T11:00:00.000Z", // Štruktúrovanie Fondu IV (Tatra Horizon)
  "2024/021": "2026-07-15T16:00:00.000Z", // Nájom prístavných pozemkov (Dunajský prístav Komárno)
  "2024/018": "2026-07-15T10:30:00.000Z", // Integrácia po akvizícii (Vltavín Software)
  "2024/003": "2026-07-14T14:00:00.000Z", // Due diligence – Tatra Horizon Fond III (Tatra Horizon)
  "2024/009": "2026-07-14T09:00:00.000Z", // Rozhodcovské konanie – dodávky technológií (Bednár & Kollár)
  "2024/015": "2026-07-13T15:00:00.000Z", // Registrácia liekov – ŠÚKL (Medika Danubia)
  "2024/007": "2026-07-13T10:00:00.000Z", // Cezhraničná akvizícia – poradenstvo (Tatra Horizon)
  "2024/011": "2026-07-12T14:00:00.000Z", // Spor spoločníkov – Viedeň (Hoch & Lindner)
};

const NOTES = [
  "Čaká sa na pripomienky klienta k poslednému návrhu",
  "Skontrolované partnerom; potrebné drobné úpravy",
  "Finálna verzia čaká na podpis",
  "Právny zástupca protistrany požiadal o predĺženie lehoty",
  "Podané na súd elektronicky",
  "Interná revízia dokončená",
  "Naplánované stretnutie s klientom k zmluvným podmienkam",
  "Potrebný preklad do angličtiny",
  "Znalecký posudok priložený samostatne",
  "Čaká sa na schválenie regulátorom",
  "Verzia so sledovanými zmenami zaslaná protistrane",
  "Pred podpisom je potrebné rozhodnutie predstavenstva",
  "Osvedčenie podpisov u notára naplánované na budúci týždeň",
  "Aktualizované podľa novely zákona",
  "Dôverné; obmedzená distribúcia",
  "Porovnané so zisteniami z due diligence",
  "Vzor aktualizovaný podľa aktuálnych štandardov",
  "Priložené posúdenie rizík",
  "Odhad odmeny uvedený v sprievodnom liste",
  "Archivované po uzavretí spisu",
];

const TIME_ENTRY_NARRATIVES = [
  "Revízia návrhu zmluvy o prevode obchodného podielu",
  "Telefonická porada s klientom k podmienkam transakcie",
  "Právna analýza regulačných požiadaviek",
  "Príprava kontrolného zoznamu pre due diligence",
  "Analýza návrhu protistrany",
  "Príprava vyjadrenia pre protistranu",
  "Revízia finančných podkladov",
  "Príprava na výsluch svedka",
  "Podanie na súd a zabezpečenie doručenia",
  "Rokovanie o podmienkach urovnania",
  "Revízia dodatkov k pracovným zmluvám",
  "Porada k posúdeniu compliance rizík",
  "Analýza cezhraničných regulačných požiadaviek",
  "GAP analýza GDPR a dokumentácia",
  "Interná porada tímu k stratégii v spise",
  "Príprava podkladov pre znalca",
  "Revízia plánu reorganizácie skupiny",
  "Analýza podmienok environmentálneho povolenia",
  "Návrh rozhodnutia valného zhromaždenia",
  "Kontrola v oblasti ochrany pred legalizáciou príjmov z trestnej činnosti",
  "Revízia ohlásenia koncentrácie pre PMÚ SR",
  "Informovanie klienta o stave sporu",
  "Analýza otázok právomoci a príslušnosti súdu",
  "Príprava dokumentácie k zavŕšeniu transakcie",
  "Revízia dodatku k nájomnej zmluve",
  "Korešpondencia s právnym zástupcom protistrany",
  "Due diligence majetku cieľovej spoločnosti",
  "Revízia portfólia duševného vlastníctva",
  "Príprava na ústne pojednávanie v rozhodcovskom konaní",
  "Analýza rozsahu poistného krytia",
  "Daňové poradenstvo k cezhraničnej transakcii",
  "Posúdenie vymáhateľnosti zákazu konkurencie",
  "Príprava zápisnice zo zasadnutia predstavenstva",
  "Rešerš predpisov o ochrane osobných údajov",
  "Návrh dodatku k zmluve o dodávkach",
  "Revízia odpovede na žiadosť regulátora",
  "Informovanie klienta o novej legislatíve",
  "Analýza nárokov zo zmluvy o dielo",
  "Príprava návrhu dohody o urovnaní",
  "Kontrola súladu s pravidlami exportnej kontroly",
];

const EXPENSE_DESCRIPTIONS = [
  "Súdny poplatok",
  "Cestovné náklady – cesta ku klientovi",
  "Odmena znalca za konzultáciu",
  "Tlač a väzba dokumentov",
  "Kuriérske doručenie podpísaných zmlúv",
  "Notársky poplatok za osvedčenie podpisu",
  "Výpis z listu vlastníctva",
  "Úradný preklad listín",
  "Prenájom zasadacej miestnosti",
  "Poštovné – doporučené zásielky",
];

const PRIMARY_TAGS = [
  "zmena kontroly",
  "ukončenie",
  "dátová miestnosť",
  "obnovenie",
] as const;

const SECONDARY_TAGS = [
  "potrebný súhlas",
  "cena",
  "ochrana údajov",
  "bezpečnosť",
] as const;

// Slovak numerals agree with the noun: "jedna protistrana", "dve/tri/štyri
// protistrany", "päť protistrán". The answers' counts are small, so the
// helpers spell out one to ten and fall back to digits.
const FEMININE_NUMERALS = [
  "žiadna",
  "jedna",
  "dve",
  "tri",
  "štyri",
  "päť",
  "šesť",
  "sedem",
  "osem",
  "deväť",
  "desať",
];

const isFew = (count: number) => count >= 2 && count <= 4;

/** The noun form for a count: one, two to four, or five and more. */
const pluralForm = (
  count: number,
  [one, few, many]: readonly [string, string, string],
) => {
  if (count === 1) {
    return one;
  }
  return isFew(count) ? few : many;
};

/** A feminine noun with its numeral; `one` gives the case of "jedna". */
const counted = (
  count: number,
  forms: readonly [string, string, string],
  one = "jedna",
) =>
  `${count === 1 ? one : (FEMININE_NUMERALS.at(count) ?? String(count))} ${pluralForm(count, forms)}`;

/** "všetkých 72 dokumentov", "všetky tri dokumenty", "jediný dokument". */
const allDocuments = (count: number) => {
  if (count === 1) {
    return "jediný dokument";
  }
  if (!isFew(count)) {
    return `všetkých ${String(count)} dokumentov`;
  }
  const numeral =
    count === 2 ? "dva" : (FEMININE_NUMERALS.at(count) ?? String(count));
  return `všetky ${numeral} dokumenty`;
};

const COUNTERPARTY_ACCUSATIVE = [
  "protistranu",
  "protistrany",
  "protistrán",
] as const;

export const SK_SEED_CONTENT = {
  colleagues: [
    {
      id: "test-user-sk-alena-hudecova",
      name: "Alena Hudecová",
      email: "alena.hudecova@stella.dev",
      image:
        "https://api.dicebear.com/9.x/avataaars/svg?seed=alena-hudecova&backgroundColor=b6e3f4",
      hourlyRate: 180,
    },
    {
      id: "test-user-sk-branislav-mikula",
      name: "Branislav Mikula",
      email: "branislav.mikula@stella.dev",
      image:
        "https://api.dicebear.com/9.x/avataaars/svg?seed=branislav-mikula&backgroundColor=d1d4f9",
      hourlyRate: 100,
    },
    {
      id: "test-user-sk-klaudia-novotna",
      name: "Klaudia Novotná",
      email: "klaudia.novotna@stella.dev",
      image:
        "https://api.dicebear.com/9.x/avataaars/svg?seed=klaudia-novotna&backgroundColor=ffd5dc",
      hourlyRate: 180,
    },
  ],
  ownerHourlyRate: 240,
  currency: "EUR",

  orgContacts: ORG_CONTACTS,
  personContacts: PERSON_CONTACTS,
  moreOrgContacts: MORE_ORG_CONTACTS,

  matters: {
    "ws-akvizice-energo": {
      // The matter the marketing editor scenes film: its breadcrumb frames
      // the Zmluva_o_dodavkach.docx redline (Severka Robotics buying drive
      // components from Meridian Precision).
      name: MARKERS.meridianMatterName,
      reference: "2026/031",
      clientIndex: 4, // Severka Robotics
      billingReference: "SEV-DOD-2026",
    },
    "ws-stavebni-spor": {
      name: "Spor o vady diela – Košice-Juh",
      reference: "2024/002",
      clientIndex: 2, // Košická stavebná spoločnosť
      billingReference: "KSS-SPOR-2024",
    },
    "ws-due-diligence": {
      name: "Due diligence – Tatra Horizon Fond III",
      reference: "2024/003",
      clientIndex: 3, // Tatra Horizon Capital
      billingReference: "THC-DD-2024",
    },
    "ws-pracovni-spory": {
      name: "Pracovnoprávne spory – Strojárne Liptov",
      reference: "2024/004",
      clientIndex: 0, // Strojárne Liptov
    },
    "ws-compliance-ceska-energie": {
      name: "Compliance program – Hronská energetika",
      reference: "2024/005",
      clientIndex: 1, // Hronská energetika
      billingReference: "HE-COMP-2024",
    },
    "ws-reorganizace": {
      name: "Reorganizácia skupiny",
      reference: "2024/006",
      clientIndex: 0, // Strojárne Liptov
    },
    "ws-cross-border": {
      name: "Cezhraničná akvizícia – poradenstvo",
      reference: "2024/007",
      clientIndex: 3, // Tatra Horizon Capital
      billingReference: "THC-MA-2024",
    },
    "ws-gdpr-audit": {
      name: "Audit GDPR a implementácia",
      reference: "2024/008",
      clientIndex: 2, // Košická stavebná spoločnosť
      billingReference: "KSS-GDPR-2024",
    },
    "ws-export-review": {
      name: MARKERS.exportReviewMatterName,
      reference: "2024/059",
      clientIndex: 3, // Tatra Horizon Capital
      billingReference: "THC-EXPORT-2024",
    },
  },
  extraMatters: EXTRA_MATTERS,
  recentMatterActivity: RECENT_MATTER_ACTIVITY,

  matterDocuments: SK_MATTER_DOCUMENTS,
  documentTexts: SK_DOCUMENT_TEXTS,
  emails: SK_EMAILS,
  spaDocumentName: SK_SPA_DOCUMENT_NAME,
  supplierAgreement: {
    fileName: MARKERS.supplierAgreementFileName,
    baseFileName: "Zmluva_o_dodavkach_v3.docx",
    baseVersionLabel: "Pôvodný návrh",
    currentVersionLabel: "Vyrokovaný návrh",
    draftMarker: "PRACOVNÁ VERZIA v4 — OBSAHUJE SLEDOVANÉ ZMENY",
    baseDraftMarker: "PRACOVNÁ VERZIA v3",
    reviewer: SUPPLIER_AGREEMENT_REVIEWER,
    comments: SUPPLIER_AGREEMENT_COMMENTS,
    paragraphs: SUPPLIER_AGREEMENT_PARAGRAPHS,
    note: "Dve ustanovenia mimo playbooku",
  },

  folders: { documents: "Dokumenty" },
  properties: {
    documents: "Dokumenty",
    status: "Stav",
    notes: "Poznámky",
    dueDate: "Termín",
    documentType: "Typ dokumentu",
    statusOptions: ["Aktívne", "V revízii", "Uzavreté", "Pozastavené"],
    documentTypePrompt: "Z priloženého súboru urči kategóriu dokumentu.",
  },
  notes: NOTES,
  documentTypeLabels: {
    nda: "Zmluva o mlčanlivosti",
    spa: "Zmluva o prevode obchodného podielu",
    apa: "Zmluva o predaji podniku",
    shareholders: "Akcionárska dohoda",
    msa: "Rámcová zmluva o poskytovaní služieb",
    sla: "Zmluva o úrovni služieb (SLA)",
    dpa: "Zmluva o spracúvaní osobných údajov",
    saas: "Zmluva o poskytovaní SaaS",
    employment: "Pracovná zmluva",
    consultancy: "Zmluva o poradenských službách",
    lease: "Nájomná zmluva",
    loan: "Zmluva o úvere",
    guarantee: "Záruka / ručiteľské vyhlásenie",
    poa: "Plnomocenstvo",
    license: "Licenčná zmluva",
    distribution: "Distribučná zmluva",
    supply: "Zmluva o dodávkach",
    settlement: "Dohoda o urovnaní",
    termsheet: "Term sheet / list o zámere",
    other: "Iné",
  },

  exportReview: {
    folders: [
      "Korporátne",
      "Obchodné zmluvy",
      "Pracovnoprávne",
      "Regulácia",
      "Financovanie",
      "Nehnuteľnosti",
    ],
    documentTypes: [
      "Zoznam akcionárov",
      "Zmluva s odberateľom",
      "Zmluva s dodávateľom",
      "Pracovná zmluva",
      "Povolenie",
      "Úverová zmluva",
      "Nájomná zmluva",
      "Poistná zmluva",
    ],
    // The agent answers and file names shorten a counterparty to its first
    // two words; the invented ones keep those comma-free (3 and 7 are fixed
    // by the cast and the markers).
    counterparties: [
      "Aurora Retail GmbH",
      "Beskyd Strojírny s.r.o.",
      "Cedar Cloud Ltd.",
      "Delta Logistika, s.r.o.",
      "Eger Bank Zrt.",
      "Flevo Analytics B.V.",
      "Granit Reality a.s.",
      "Helios Energia, a.s.",
    ],
    jurisdictions: [
      "Slovenská republika",
      "Nemecko",
      "Holandsko",
      "Maďarsko",
      "Spojené kráľovstvo",
    ],
    governingLaws: [
      "slovenské právo",
      "nemecké právo",
      "holandské právo",
      "maďarské právo",
      "anglické právo",
    ],
    riskLevels: ["Nízke", "Stredné", "Vysoké", "Kritické"],
    reviewStatuses: ["Nezačaté", "V revízii", "Čaká na partnera", "Schválené"],
    evidenceQuality: ["Priama citácia", "Overiť zdroj", "Rozporné podklady"],
    primaryTags: PRIMARY_TAGS,
    secondaryTags: SECONDARY_TAGS,
    keyObligation: (counterparty) =>
      `Spoločnosť ${counterparty} je povinná pred akýmkoľvek postúpením, obnovením alebo podstatnou zmenou služieb doručiť písomné oznámenie.`,
    riskFinding: {
      elevated:
        "Práva na udelenie súhlasu, oznámenie alebo ukončenie zmluvy si pred podpisom vyžadujú posúdenie partnerom.",
      ordinary:
        "Nezistila sa žiadna blokujúca prekážka; pred zavŕšením transakcie overte plnenie povinností v bežnom obchodnom styku.",
    },
    formatContractValue: (value) => `${String(value)} EUR`,
    extract: {
      heading: (documentType) =>
        `${documentType.toUpperCase()} — VÝŤAH NA PREVERENIE`,
      intro: ({ counterparty, documentType, jurisdiction }) =>
        `${counterparty} (jurisdikcia: ${jurisdiction}) je zmluvnou stranou dokumentu „${documentType}“, ktorý sa preveruje v rámci dátovej miestnosti Projektu Atlas.`,
      keyTerms: "Kľúčové údaje",
      labels: {
        document: "Dokument",
        documentType: "Typ dokumentu",
        counterparty: "Protistrana",
        jurisdiction: "Jurisdikcia",
        governingLaw: "Rozhodné právo",
        effectiveDate: "Účinnosť od",
        expiryDate: "Platnosť do",
        contractValue: "Hodnota zmluvy",
        riskLevel: "Úroveň rizika",
        reviewStatus: "Stav preverenia",
        evidenceQuality: "Kvalita podkladov",
        tags: "Štítky",
      },
      keyObligation: "Kľúčová povinnosť",
      riskFinding: "Zistené riziko",
      underReview: "Preverované ustanovenie:",
      clause: ({ counterparty, governingLaw }) =>
        `„Spoločnosť ${counterparty} je povinná plniť vyššie uvedenú povinnosť a rozhodným právom je ${governingLaw}.“`,
    },
    statements: {
      "document-type": (row) => `Typ dokumentu určený ako ${row.documentType}.`,
      counterparty: (row) => `Protistrana určená ako ${row.counterparty}.`,
      jurisdiction: (row) => `Jurisdikcia určená ako ${row.jurisdiction}.`,
      "governing-law": (row) =>
        `Rozhodné právo určené ako ${row.governingLaw}.`,
      "effective-date": (row) =>
        `Dátum účinnosti určený ako ${row.effectiveDate}.`,
      "expiry-date": (row) =>
        `Dátum skončenia platnosti určený ako ${row.expiryDate}.`,
      "contract-value": (row) =>
        `Hodnota zmluvy určená ako ${String(row.contractValue)} EUR.`,
      "risk-level": (row) =>
        `Úroveň rizika klasifikovaná ako „${row.riskLevel}“.`,
      "evidence-quality": (row) =>
        `Kvalita podkladov klasifikovaná ako „${row.evidenceQuality}“.`,
      tags: (row) => `Štítky určené ako ${row.tags.join(", ")}.`,
      "key-obligation": () =>
        "Kľúčová povinnosť prevzatá z časti o povinnostiach.",
      "risk-finding": () => "Zistené riziko prevzaté z časti o rizikách.",
    },
    columns: {
      documentType: {
        name: "Typ dokumentu",
        prompt: "Z priloženého súboru urči kategóriu dokumentu.",
      },
      counterparty: {
        name: "Protistrana",
        prompt: "Urči hlavnú protistranu uvedenú v dokumente.",
      },
      jurisdiction: {
        name: "Jurisdikcia",
        prompt: "Urči jurisdikciu, ktorej sa dokument týka.",
      },
      governingLaw: {
        name: "Rozhodné právo",
        prompt: "Vyhľadaj ustanovenie o rozhodnom práve.",
      },
      effectiveDate: {
        name: "Účinnosť od",
        prompt: "Uveď dátum účinnosti vo formáte ISO.",
      },
      expiryDate: {
        name: "Platnosť do",
        prompt:
          "Uveď dátum skončenia platnosti alebo obnovenia vo formáte ISO.",
      },
      contractValue: {
        name: "Hodnota zmluvy",
        prompt: "Uveď hodnotu zmluvy v eurách.",
      },
      riskLevel: {
        name: "Úroveň rizika",
        prompt: "Klasifikuj úroveň rizika z hľadiska due diligence.",
      },
      reviewStatus: { name: "Stav preverenia" },
      evidenceQuality: {
        name: "Kvalita podkladov",
        prompt: "Posúď, či má vyťažená hodnota priamu oporu v texte.",
      },
      tags: {
        name: "Štítky",
        prompt: "Navrhni stručné štítky pre due diligence.",
      },
      keyObligation: {
        name: "Kľúčová povinnosť",
        prompt: "Uveď kľúčovú povinnosť relevantnú pre zavŕšenie transakcie.",
      },
      riskFinding: {
        name: "Zistené riziko",
        prompt: "Zhrň hlavné riziko z due diligence jednou vetou.",
      },
    },
  },

  agent: {
    formattingLocale: "sk-SK",
    viewLabels: {
      title: "Dosahy zmeny kontroly",
      scope:
        "Dátová miestnosť Projektu Atlas · všetky zmluvy, hodnota zmlúv sčítaná za každú protistranu",
      positions: {
        consent: "Posúdenie súhlasu alebo ukončenia",
        confirm: "Súhlas na overenie",
        notice: "Len oznámenie",
      },
      statDetail:
        "{counterparties} protistrany · {documents} dokumentov · {share} hodnoty",
      splitLabel: "Podiel na hodnote zmlúv podľa dosahu zmeny kontroly",
      columns: [
        "Protistrana",
        "Zmluva",
        "Dokumenty",
        "Hodnota zmlúv",
        "Riziko",
        "Zmena kontroly",
      ],
    },
    agreementLabel: (documentType, year) => `${documentType} ${year}`,
    firstAnswerIntro: ({ documentCount, consentCount }) =>
      `Preverenie pokrylo ${allDocuments(documentCount)} v dátovej miestnosti. Každá zmluva vyžaduje pred postúpením, obnovením alebo podstatnou zmenou služieb písomné oznámenie, takže zmena kontroly vyvolá prinajmenšom oznamovaciu povinnosť pri každej z nich. Prísnejší režim platí len pre ${counted(consentCount, COUNTERPARTY_ACCUSATIVE, "jednu")}: ${consentCount === 1 ? "jej výťah z preverenia uvádza" : "ich výťahy z preverenia uvádzajú"} práva na udelenie súhlasu alebo ukončenie zmluvy, ktoré si pred podpisom vyžadujú posúdenie partnerom.`,
    tableColumns: ["Protistrana", "Zmluva", "Riziko", "Dosah zmeny kontroly"],
    firstAnswerOutro: ({ confirmNames }) =>
      `Zmluvy so spoločnosťami ${confirmNames} neobsahujú žiadnu blokujúcu prekážku, každá však nesie štítok „${SECONDARY_TAGS[0]}“, preto treba pred podpisom overiť, či sa súhlas vyžaduje.`,
    secondAnswerLead: ({
      counterparty,
      criticalCount,
      riskFinding,
      riskFindingCitation,
      keyObligation,
      keyObligationCitation,
    }) =>
      `Úverová zmluva so spoločnosťou ${counterparty} ${criticalCount === 1 ? "je jedinou kritickou zmluvou" : `patrí medzi ${counted(criticalCount, ["kritickú zmluvu", "kritické zmluvy", "kritických zmlúv"])}`}. Jej výťah z preverenia uvádza: „${riskFinding}“ ${riskFindingCitation} K tomu sa pridáva štandardná povinnosť: „${keyObligation}“ ${keyObligationCitation}`,
    citationLabels: {
      riskFinding: "Zistené riziko",
      keyObligation: "Kľúčová povinnosť",
      governingLaw: "Rozhodné právo",
      expiryDate: "Platnosť do",
      contractValue: "Hodnota zmluvy",
    },
    factLabels: {
      governingLaw: "Rozhodné právo",
      expires: "Platnosť do",
      contractValue: "Hodnota zmluvy",
    },
    thirdAnswerLead: ({
      share,
      consentValue,
      totalValue,
      consentCount,
      criticalCount,
      firstCriticalCitation,
      secondCriticalCitation,
    }) =>
      `Nižšie je prehľad dosahov podľa protistrán. Na ${counted(consentCount, COUNTERPARTY_ACCUSATIVE, "jednu")}, ${consentCount === 1 ? "ktorá si vyžaduje" : "ktoré si vyžadujú"} posúdenie súhlasu alebo ukončenia, pripadá ${share} hodnoty zmlúv v dátovej miestnosti (${consentValue} z ${totalValue}). Na čele ${isFew(criticalCount) ? "sú" : "je"} ${counted(criticalCount, ["kritická zmluva", "kritické zmluvy", "kritických zmlúv"])}: ${firstCriticalCitation} a ${secondCriticalCitation}.`,
    thirdAnswerFollowUp: ({ confirmNames, consentCount }) =>
      `Ďalší krok: overiť otázku súhlasu so spoločnosťami ${confirmNames} a následne pripraviť žiadosti o súhlas pre ${counted(consentCount, ["preverovanú protistranu", "preverované protistrany", "preverovaných protistrán"], "jednu")}.`,
    recap: ({ consentNames, confirmNames }) =>
      `${MARKERS.agent.recapPrefix}: zmluvy so spoločnosťami ${consentNames} si vyžadujú posúdenie súhlasu alebo ukončenia a prehľad dosahov ich zhŕňa pre poradu partnerov. Otvorené zostáva overenie súhlasu pri spoločnostiach ${confirmNames}.`,
  },

  billing: {
    taskCodeLabels: {
      RESEARCH: "Právna rešerš",
      REVIEW: "Revízia dokumentov",
      DRAFT: "Príprava dokumentov",
      MEETING: "Porada / stretnutie",
      COURT: "Účasť na pojednávaní",
      FILING: "Podania a doručovanie",
      DISCOVERY: "Zabezpečovanie dôkazov",
      NEGOTIATE: "Rokovania",
      ADVISE: "Poradenstvo",
      ADMIN: "Administratíva",
    },
    activityCodeLabels: {
      PLAN: "Plánovanie a stratégia",
      COMMUNICATE: "Komunikácia",
      ANALYZE: "Analýza",
      MANAGE: "Správa spisu",
      TRAVEL: "Cestovanie",
      ATTEND: "Účasť",
      PREPARE: "Príprava",
      CORRESPOND: "Korešpondencia",
    },
    timeEntryNarratives: TIME_ENTRY_NARRATIVES,
    invoiceEntryNarratives: [
      "Revízia korporátnych dokumentov cieľovej spoločnosti podľa kontrolného zoznamu právnej DD",
      "Analýza štruktúry skupiny a zoznamu akcionárov",
      "Revízia regulačných povolení a zistení v oblasti compliance",
      "Zhrnutie rizík z doložiek o zmene kontroly v podstatných zmluvách",
      "Pripomienkovanie vyhlásení, záruk a odškodnení v zmluve o kúpe akcií",
      "Telefonát s klientom k zoznamu výnimiek a pripomienkam k zmluve o kúpe akcií",
    ],
    expenseDescriptions: EXPENSE_DESCRIPTIONS,
    rateTableName: "Predvolený sadzobník",
    invoiceNumberPrefix: "FA",
  },
  issuing: {
    seller: {
      legalName: "Hrabovský & Partneri, advokátska kancelária, s.r.o.",
      registrationId: "53184297",
      vatId: "SK2121456789",
      addressLine1: "Štúrova 9",
      city: "Bratislava",
      postalCode: "811 02",
      country: "SK",
      iban: "SK7411000000002945001234",
    },
    vatRates: {
      standard: {
        name: "Základná sadzba",
        rateBps: 2300,
        validFrom: "2025-01-01",
      },
      reduced: {
        name: "Znížená sadzba",
        rateBps: 1900,
        validFrom: "2025-01-01",
      },
    },
    numberSeriesName: "Faktúry",
  },
  templates: {
    categories: {
      "tmpl-cat-corporate": {
        name: "Obchodné spoločnosti",
        description:
          "Vzory zmlúv o prevode obchodného podielu, akcionárskych dohôd a rozhodnutí orgánov spoločnosti.",
      },
      "tmpl-cat-employment": {
        name: "Pracovné právo",
        description:
          "Pracovné zmluvy, zmluvy o mlčanlivosti a ďalšie personálne vzory.",
      },
      "tmpl-cat-commercial": {
        name: "Obchodné zmluvy",
        description:
          "Rámcové zmluvy o poskytovaní služieb, SLA a ďalšie vzory obchodných zmlúv.",
      },
      "tmpl-cat-real-estate": {
        name: "Nehnuteľnosti",
        description:
          "Nájomné zmluvy, licencie a vzory pre transakcie s nehnuteľnosťami.",
      },
    },
    templates: {
      "tmpl-spa": {
        name: "Zmluva o prevode obchodného podielu",
        fileName: "Zmluva_o_prevode_obchodneho_podielu.docx",
      },
      "tmpl-board-resolution": {
        name: "Rozhodnutie predstavenstva",
        fileName: "Rozhodnutie_predstavenstva.docx",
      },
      "tmpl-shareholders": {
        name: "Akcionárska dohoda",
        fileName: "Akcionarska_dohoda.docx",
      },
      "tmpl-employment": {
        name: "Pracovná zmluva",
        fileName: "Pracovna_zmluva.docx",
      },
      "tmpl-nda": {
        name: "Zmluva o mlčanlivosti",
        fileName: "Zmluva_o_mlcanlivosti.docx",
      },
      "tmpl-msa": {
        name: "Rámcová zmluva o poskytovaní služieb",
        fileName: "Ramcova_zmluva_o_poskytovani_sluzieb.docx",
      },
      "tmpl-sla": {
        name: "Zmluva o úrovni služieb (SLA)",
        fileName: "Zmluva_o_urovni_sluzieb_SLA.docx",
      },
      "tmpl-supply": {
        name: "Zmluva o dodávkach",
        // Distinct from the Meridian matter's Zmluva_o_dodavkach.docx, which
        // the editor captures look up by name.
        fileName: "Zmluva_o_dodavkach_vzor.docx",
      },
      "tmpl-lease": {
        name: "Nájomná zmluva",
        fileName: "Najomna_zmluva.docx",
      },
    },
  },
} satisfies SeedLocaleContent;
