/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/estonian.sbl -js -o estonian
 *
 * The generator emits JavaScript; the committed module is that output with
 * mechanical, script-applied edits only (module header, named export, type
 * annotations the repo's strict TypeScript settings require, total
 * substitution-table reads, and the removal of labels nothing jumps to).
 * No algorithm logic is edited.
 *
 * Copyright (c) 2001, Dr Martin Porter
 * Copyright (c) 2004,2005, Richard Boulton
 * Copyright (c) 2013, Yoshiki Shibukawa
 * Copyright (c) 2006-2025, Olly Betts
 * All rights reserved. Distributed under the BSD 3-Clause licence; see the
 * full notice in ./base-stemmer.ts.
 */

import type { AmongTable } from "@/api/lib/legal-search/morphology/snowball/base-stemmer";
import {
  BaseStemmer,
  substitution,
} from "@/api/lib/legal-search/morphology/snowball/base-stemmer";

// Generated from estonian.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["gi", 1],
    ["ki", 2]
];

const a_1: AmongTable = [
    ["da", 3],
    ["mata", 1],
    ["b", 3],
    ["ksid", 1],
    ["nuksid", 1, 1],
    ["me", 3],
    ["sime", 1, 1],
    ["ksime", 1, 1],
    ["nuksime", 1, 1],
    ["akse", 2],
    ["dakse", 1, 1],
    ["takse", 1, 2],
    ["site", 1],
    ["ksite", 1, 1],
    ["nuksite", 1, 1],
    ["n", 3],
    ["sin", 1, 1],
    ["ksin", 1, 1],
    ["nuksin", 1, 1],
    ["daks", 1],
    ["taks", 1]
];

const a_2: AmongTable = [
    ["aa", -1],
    ["ee", -1],
    ["ii", -1],
    ["oo", -1],
    ["uu", -1],
    ["\u00E4\u00E4", -1],
    ["\u00F5\u00F5", -1],
    ["\u00F6\u00F6", -1],
    ["\u00FC\u00FC", -1]
];

const a_3: AmongTable = [
    ["lane", 1],
    ["line", 3],
    ["mine", 2],
    ["lasse", 1],
    ["lisse", 3],
    ["misse", 2],
    ["lasi", 1],
    ["lisi", 3],
    ["misi", 2],
    ["last", 1],
    ["list", 3],
    ["mist", 2]
];

const as_3: readonly string[] = ["lase", "mise", "lise"];

const a_4: AmongTable = [
    ["ga", 1],
    ["ta", 1],
    ["le", 1],
    ["sse", 1],
    ["l", 1],
    ["s", 1],
    ["ks", 1, 1],
    ["t", 2],
    ["lt", 1, 1],
    ["st", 1, 2]
];

const a_5: AmongTable = [
    ["", 2],
    ["las", 1, 1],
    ["lis", 1, 2],
    ["mis", 1, 3],
    ["t", -1, 4]
];

const as_5: readonly string[] = ["e", ""];

const a_6: AmongTable = [
    ["d", 4],
    ["sid", 2, 1],
    ["de", 4],
    ["ikkude", 1, 1],
    ["ike", 1],
    ["ikke", 1],
    ["te", 3]
];

const a_7: AmongTable = [
    ["va", -1],
    ["du", -1],
    ["nu", -1],
    ["tu", -1]
];

const a_8: AmongTable = [
    ["kk", 1],
    ["pp", 2],
    ["tt", 3]
];

const as_8: readonly string[] = ["k", "p", "t"];

const a_9: AmongTable = [
    ["ma", 2],
    ["mai", 1],
    ["m", 1]
];

const a_10: AmongTable = [
    ["joob", 1],
    ["jood", 1],
    ["joodakse", 1, 1],
    ["jooma", 1],
    ["joomata", 1, 1],
    ["joome", 1],
    ["joon", 1],
    ["joote", 1],
    ["joovad", 1],
    ["juua", 1],
    ["juuakse", 1, 1],
    ["j\u00E4i", 12],
    ["j\u00E4id", 12, 1],
    ["j\u00E4ime", 12, 2],
    ["j\u00E4in", 12, 3],
    ["j\u00E4ite", 12, 4],
    ["j\u00E4\u00E4b", 12],
    ["j\u00E4\u00E4d", 12],
    ["j\u00E4\u00E4da", 12, 1],
    ["j\u00E4\u00E4dakse", 12, 1],
    ["j\u00E4\u00E4di", 12, 3],
    ["j\u00E4\u00E4ks", 12],
    ["j\u00E4\u00E4ksid", 12, 1],
    ["j\u00E4\u00E4ksime", 12, 2],
    ["j\u00E4\u00E4ksin", 12, 3],
    ["j\u00E4\u00E4ksite", 12, 4],
    ["j\u00E4\u00E4ma", 12],
    ["j\u00E4\u00E4mata", 12, 1],
    ["j\u00E4\u00E4me", 12],
    ["j\u00E4\u00E4n", 12],
    ["j\u00E4\u00E4te", 12],
    ["j\u00E4\u00E4vad", 12],
    ["j\u00F5i", 1],
    ["j\u00F5id", 1, 1],
    ["j\u00F5ime", 1, 2],
    ["j\u00F5in", 1, 3],
    ["j\u00F5ite", 1, 4],
    ["keeb", 4],
    ["keed", 4],
    ["keedakse", 4, 1],
    ["keeks", 4],
    ["keeksid", 4, 1],
    ["keeksime", 4, 2],
    ["keeksin", 4, 3],
    ["keeksite", 4, 4],
    ["keema", 4],
    ["keemata", 4, 1],
    ["keeme", 4],
    ["keen", 4],
    ["kees", 4],
    ["keeta", 4],
    ["keete", 4],
    ["keevad", 4],
    ["k\u00E4ia", 8],
    ["k\u00E4iakse", 8, 1],
    ["k\u00E4ib", 8],
    ["k\u00E4id", 8],
    ["k\u00E4idi", 8, 1],
    ["k\u00E4iks", 8],
    ["k\u00E4iksid", 8, 1],
    ["k\u00E4iksime", 8, 2],
    ["k\u00E4iksin", 8, 3],
    ["k\u00E4iksite", 8, 4],
    ["k\u00E4ima", 8],
    ["k\u00E4imata", 8, 1],
    ["k\u00E4ime", 8],
    ["k\u00E4in", 8],
    ["k\u00E4is", 8],
    ["k\u00E4ite", 8],
    ["k\u00E4ivad", 8],
    ["laob", 16],
    ["laod", 16],
    ["laoks", 16],
    ["laoksid", 16, 1],
    ["laoksime", 16, 2],
    ["laoksin", 16, 3],
    ["laoksite", 16, 4],
    ["laome", 16],
    ["laon", 16],
    ["laote", 16],
    ["laovad", 16],
    ["loeb", 14],
    ["loed", 14],
    ["loeks", 14],
    ["loeksid", 14, 1],
    ["loeksime", 14, 2],
    ["loeksin", 14, 3],
    ["loeksite", 14, 4],
    ["loeme", 14],
    ["loen", 14],
    ["loete", 14],
    ["loevad", 14],
    ["loob", 7],
    ["lood", 7],
    ["loodi", 7, 1],
    ["looks", 7],
    ["looksid", 7, 1],
    ["looksime", 7, 2],
    ["looksin", 7, 3],
    ["looksite", 7, 4],
    ["looma", 7],
    ["loomata", 7, 1],
    ["loome", 7],
    ["loon", 7],
    ["loote", 7],
    ["loovad", 7],
    ["luua", 7],
    ["luuakse", 7, 1],
    ["l\u00F5i", 6],
    ["l\u00F5id", 6, 1],
    ["l\u00F5ime", 6, 2],
    ["l\u00F5in", 6, 3],
    ["l\u00F5ite", 6, 4],
    ["l\u00F6\u00F6b", 5],
    ["l\u00F6\u00F6d", 5],
    ["l\u00F6\u00F6dakse", 5, 1],
    ["l\u00F6\u00F6di", 5, 2],
    ["l\u00F6\u00F6ks", 5],
    ["l\u00F6\u00F6ksid", 5, 1],
    ["l\u00F6\u00F6ksime", 5, 2],
    ["l\u00F6\u00F6ksin", 5, 3],
    ["l\u00F6\u00F6ksite", 5, 4],
    ["l\u00F6\u00F6ma", 5],
    ["l\u00F6\u00F6mata", 5, 1],
    ["l\u00F6\u00F6me", 5],
    ["l\u00F6\u00F6n", 5],
    ["l\u00F6\u00F6te", 5],
    ["l\u00F6\u00F6vad", 5],
    ["l\u00FC\u00FCa", 5],
    ["l\u00FC\u00FCakse", 5, 1],
    ["m\u00FC\u00FCa", 13],
    ["m\u00FC\u00FCakse", 13, 1],
    ["m\u00FC\u00FCb", 13],
    ["m\u00FC\u00FCd", 13],
    ["m\u00FC\u00FCdi", 13, 1],
    ["m\u00FC\u00FCks", 13],
    ["m\u00FC\u00FCksid", 13, 1],
    ["m\u00FC\u00FCksime", 13, 2],
    ["m\u00FC\u00FCksin", 13, 3],
    ["m\u00FC\u00FCksite", 13, 4],
    ["m\u00FC\u00FCma", 13],
    ["m\u00FC\u00FCmata", 13, 1],
    ["m\u00FC\u00FCme", 13],
    ["m\u00FC\u00FCn", 13],
    ["m\u00FC\u00FCs", 13],
    ["m\u00FC\u00FCte", 13],
    ["m\u00FC\u00FCvad", 13],
    ["n\u00E4eb", 18],
    ["n\u00E4ed", 18],
    ["n\u00E4eks", 18],
    ["n\u00E4eksid", 18, 1],
    ["n\u00E4eksime", 18, 2],
    ["n\u00E4eksin", 18, 3],
    ["n\u00E4eksite", 18, 4],
    ["n\u00E4eme", 18],
    ["n\u00E4en", 18],
    ["n\u00E4ete", 18],
    ["n\u00E4evad", 18],
    ["n\u00E4gema", 18],
    ["n\u00E4gemata", 18, 1],
    ["n\u00E4ha", 18],
    ["n\u00E4hakse", 18, 1],
    ["n\u00E4hti", 18],
    ["p\u00F5eb", 15],
    ["p\u00F5ed", 15],
    ["p\u00F5eks", 15],
    ["p\u00F5eksid", 15, 1],
    ["p\u00F5eksime", 15, 2],
    ["p\u00F5eksin", 15, 3],
    ["p\u00F5eksite", 15, 4],
    ["p\u00F5eme", 15],
    ["p\u00F5en", 15],
    ["p\u00F5ete", 15],
    ["p\u00F5evad", 15],
    ["saab", 2],
    ["saad", 2],
    ["saada", 2, 1],
    ["saadakse", 2, 1],
    ["saadi", 2, 3],
    ["saaks", 2],
    ["saaksid", 2, 1],
    ["saaksime", 2, 2],
    ["saaksin", 2, 3],
    ["saaksite", 2, 4],
    ["saama", 2],
    ["saamata", 2, 1],
    ["saame", 2],
    ["saan", 2],
    ["saate", 2],
    ["saavad", 2],
    ["sai", 2],
    ["said", 2, 1],
    ["saime", 2, 2],
    ["sain", 2, 3],
    ["saite", 2, 4],
    ["s\u00F5i", 9],
    ["s\u00F5id", 9, 1],
    ["s\u00F5ime", 9, 2],
    ["s\u00F5in", 9, 3],
    ["s\u00F5ite", 9, 4],
    ["s\u00F6\u00F6b", 9],
    ["s\u00F6\u00F6d", 9],
    ["s\u00F6\u00F6dakse", 9, 1],
    ["s\u00F6\u00F6di", 9, 2],
    ["s\u00F6\u00F6ks", 9],
    ["s\u00F6\u00F6ksid", 9, 1],
    ["s\u00F6\u00F6ksime", 9, 2],
    ["s\u00F6\u00F6ksin", 9, 3],
    ["s\u00F6\u00F6ksite", 9, 4],
    ["s\u00F6\u00F6ma", 9],
    ["s\u00F6\u00F6mata", 9, 1],
    ["s\u00F6\u00F6me", 9],
    ["s\u00F6\u00F6n", 9],
    ["s\u00F6\u00F6te", 9],
    ["s\u00F6\u00F6vad", 9],
    ["s\u00FC\u00FCa", 9],
    ["s\u00FC\u00FCakse", 9, 1],
    ["teeb", 17],
    ["teed", 17],
    ["teeks", 17],
    ["teeksid", 17, 1],
    ["teeksime", 17, 2],
    ["teeksin", 17, 3],
    ["teeksite", 17, 4],
    ["teeme", 17],
    ["teen", 17],
    ["teete", 17],
    ["teevad", 17],
    ["tegema", 17],
    ["tegemata", 17, 1],
    ["teha", 17],
    ["tehakse", 17, 1],
    ["tehti", 17],
    ["toob", 10],
    ["tood", 10],
    ["toodi", 10, 1],
    ["tooks", 10],
    ["tooksid", 10, 1],
    ["tooksime", 10, 2],
    ["tooksin", 10, 3],
    ["tooksite", 10, 4],
    ["tooma", 10],
    ["toomata", 10, 1],
    ["toome", 10],
    ["toon", 10],
    ["toote", 10],
    ["toovad", 10],
    ["tuua", 10],
    ["tuuakse", 10, 1],
    ["t\u00F5i", 10],
    ["t\u00F5id", 10, 1],
    ["t\u00F5ime", 10, 2],
    ["t\u00F5in", 10, 3],
    ["t\u00F5ite", 10, 4],
    ["viia", 3],
    ["viiakse", 3, 1],
    ["viib", 3],
    ["viid", 3],
    ["viidi", 3, 1],
    ["viiks", 3],
    ["viiksid", 3, 1],
    ["viiksime", 3, 2],
    ["viiksin", 3, 3],
    ["viiksite", 3, 4],
    ["viima", 3],
    ["viimata", 3, 1],
    ["viime", 3],
    ["viin", 3],
    ["viisime", 3],
    ["viisin", 3],
    ["viisite", 3],
    ["viite", 3],
    ["viivad", 3],
    ["v\u00F5ib", 11],
    ["v\u00F5id", 11],
    ["v\u00F5ida", 11, 1],
    ["v\u00F5idakse", 11, 1],
    ["v\u00F5idi", 11, 3],
    ["v\u00F5iks", 11],
    ["v\u00F5iksid", 11, 1],
    ["v\u00F5iksime", 11, 2],
    ["v\u00F5iksin", 11, 3],
    ["v\u00F5iksite", 11, 4],
    ["v\u00F5ima", 11],
    ["v\u00F5imata", 11, 1],
    ["v\u00F5ime", 11],
    ["v\u00F5in", 11],
    ["v\u00F5is", 11],
    ["v\u00F5ite", 11],
    ["v\u00F5ivad", 11]
];

const as_10: readonly string[] = ["joo", "saa", "viima", "keesi", "l\u00F6\u00F6", "l\u00F5i", "loo", "k\u00E4isi", "s\u00F6\u00F6", "too", "v\u00F5isi", "j\u00E4\u00E4ma", "m\u00FC\u00FCsi", "luge", "p\u00F5de", "ladu", "tegi", "n\u00E4gi"];

const g_V1: readonly number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 48, 8];

const g_RV: readonly number[] = [1, 0, 0, 0, 0, 0, 0, 68, 4, 65];

const g_KI: readonly number[] = [117, 66, 6, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 16];

const g_GI: readonly number[] = [21, 123, 243, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 48, 8];


export class EstonianStemmer extends BaseStemmer {

    #I_p1 = 0;


    /** @return {boolean} */
    #r_mark_regions() {
        this.#I_p1 = this.limit;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (this.c + 2 > this.limit) break lab1;
                this.c += 2;
                // deno-lint-ignore no-unused-labels
                golab2: while (true)
                {
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        if (!(this.eq_s("'"))) break lab3;
                        break golab2;
                    }
                    if (this.c >= this.limit) break lab1;
                    this.c++;
                }
                break lab0;
            }
            this.c = v_1;
            if (!this.go_out_grouping(g_V1, 97, 252)) return false;
            this.c++;
            if (!this.go_in_grouping(g_V1, 97, 252)) return false;
            this.c++;
        }
        this.#I_p1 = this.c;
        return true;
    }

    /** @return {boolean} */
    #r_emphasis() {
        let a: number;
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        a = this.find_among_b(a_0);
        if (a === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        const v_2 = this.limit - this.c;
        if (this.c - 4 < this.limit_backward) return false;
        this.c -= 4;
        this.c = this.limit - v_2;
        switch (a) {
            case 1: {
                const v_3 = this.limit - this.c;
                if (!(this.in_grouping_b(g_GI, 97, 252))) return false;
                this.c = this.limit - v_3;
                {
                    const v_4 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab0: {
                        if (!this.#r_LONGV()) break lab0;
                        return false;
                    }
                    this.c = this.limit - v_4;
                }
                this.slice_del();
                break;
            }
            case 2: {
                if (!(this.in_grouping_b(g_KI, 98, 382))) return false;
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_verb() {
        let a: number;
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        a = this.find_among_b(a_1);
        if (a === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        switch (a) {
            case 1: {
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_from("a");
                break;
            }
            case 3: {
                if (!(this.in_grouping_b(g_V1, 97, 252))) return false;
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_LONGV() {
        return this.find_among_b(a_2) !== 0;
    }

    /** @return {boolean} */
    #r_i_plural() {
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        if (!(this.eq_s_b("i"))) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        if (!(this.in_grouping_b(g_RV, 39, 117))) return false;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_special_noun_endings() {
        let a: number;
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        a = this.find_among_b(a_3);
        if (a === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        this.slice_from(substitution(as_3, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_case_ending() {
        let a: number;
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        a = this.find_among_b(a_4);
        if (a === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        switch (a) {
            case 1: {
                // deno-lint-ignore no-unused-labels
                lab0: {
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        if (!(this.in_grouping_b(g_RV, 39, 117))) break lab1;
                        break lab0;
                    }
                    if (!this.#r_LONGV()) return false;
                }
                break;
            }
            case 2: {
                const v_2 = this.limit - this.c;
                if (this.c - 4 < this.limit_backward) return false;
                this.c -= 4;
                this.c = this.limit - v_2;
                break;
            }
        }
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_plural_three_first_cases() {
        let a: number;
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        a = this.find_among_b(a_6);
        if (a === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        switch (a) {
            case 1: {
                this.slice_from("iku");
                break;
            }
            case 2: {
                {
                    const v_2 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab0: {
                        if (!this.#r_LONGV()) break lab0;
                        return false;
                    }
                    this.c = this.limit - v_2;
                }
                this.slice_del();
                break;
            }
            case 3: {
                // deno-lint-ignore no-unused-labels
                lab1: {
                    const v_3 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab2: {
                        const v_4 = this.limit - this.c;
                        if (this.c - 4 < this.limit_backward) break lab2;
                        this.c -= 4;
                        this.c = this.limit - v_4;
                        a = this.find_among_b(a_5);
                        if (a > 0) {
                            this.slice_from(substitution(as_5, a - 1));
                        }
                        break lab1;
                    }
                    this.c = this.limit - v_3;
                    this.slice_from("t");
                }
                break;
            }
            case 4: {
                // deno-lint-ignore no-unused-labels
                lab3: {
                    // deno-lint-ignore no-unused-labels
                    lab4: {
                        if (!(this.in_grouping_b(g_RV, 39, 117))) break lab4;
                        break lab3;
                    }
                    if (!this.#r_LONGV()) return false;
                }
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_nu() {
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        if (this.find_among_b(a_7) === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_undouble_kpt() {
        let a: number;
        if (!(this.in_grouping_b(g_V1, 97, 252))) return false;
        if (this.#I_p1 > this.c) return false;
        this.ket = this.c;
        a = this.find_among_b(a_8);
        if (a === 0) return false;
        this.bra = this.c;
        this.slice_from(substitution(as_8, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_degrees() {
        let a: number;
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        a = this.find_among_b(a_9);
        if (a === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        switch (a) {
            case 1: {
                if (!(this.in_grouping_b(g_RV, 39, 117))) return false;
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_substantive() {
        const v_1 = this.limit - this.c;
        this.#r_special_noun_endings();
        this.c = this.limit - v_1;
        const v_2 = this.limit - this.c;
        this.#r_case_ending();
        this.c = this.limit - v_2;
        const v_3 = this.limit - this.c;
        this.#r_plural_three_first_cases();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        this.#r_degrees();
        this.c = this.limit - v_4;
        const v_5 = this.limit - this.c;
        this.#r_i_plural();
        this.c = this.limit - v_5;
        const v_6 = this.limit - this.c;
        this.#r_nu();
        this.c = this.limit - v_6;
        return true;
    }

    /** @return {boolean} */
    #r_verb_exceptions() {
        let a: number;
        this.bra = this.c;
        a = this.find_among(a_10);
        if (a === 0) return false;
        this.ket = this.c;
        if (this.c < this.limit) return false;
        this.slice_from(substitution(as_10, a - 1));
        return true;
    }

    /** @return {boolean} */
    #stem() {
        {
            const v_1 = this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                if (!this.#r_verb_exceptions()) break lab0;
                return false;
            }
            this.c = v_1;
        }
        const v_2 = this.c;
        this.#r_mark_regions();
        this.c = v_2;
        this.limit_backward = this.c; this.c = this.limit;
        const v_3 = this.limit - this.c;
        this.#r_emphasis();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        {
            // deno-lint-ignore no-unused-labels
            lab2: {
                const v_5 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab3: {
                    if (!this.#r_verb()) break lab3;
                    break lab2;
                }
                this.c = this.limit - v_5;
                this.#r_substantive();
            }
        }
        this.c = this.limit - v_4;
        const v_6 = this.limit - this.c;
        this.#r_undouble_kpt();
        this.c = this.limit - v_6;
        this.ket = this.c;
        if (!(this.eq_s_b("'"))) return false;
        this.bra = this.c;
        this.slice_del();
        this.c = this.limit_backward;
        return true;
    }

    /**@return{string}*/
    stem(input: string): string {
        this.setCurrent(input);
        this.#stem();
        return this.getCurrent();
    }

    stemWord = this.stem;
}
