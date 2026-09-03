/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/czech.sbl -js -o czech
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

// Generated from czech.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["c", 1],
    ["nc", -1, 1],
    ["\u00EDnc", 2, 1],
    ["avc", -1, 3],
    ["ovc", -1, 4]
];

const as_0: readonly string[] = ["k", "\u00EDnk"];

const a_1: AmongTable = [
    ["c", 1],
    ["nc", -1, 1],
    ["\u00EDnc", 2, 1],
    ["avc", -1, 3],
    ["ovc", -1, 4],
    ["\u010Dt", 3],
    ["\u0161t", 4],
    ["de\u0161t", -1, 1],
    ["le\u0161t", -1, 2],
    ["i\u0161t", -1, 3],
    ["pou\u0161t", -1, 4],
    ["\u00E1\u0161t", -1, 5],
    ["\u00ED\u0161t", -1, 6]
];

const as_1: readonly string[] = ["k", "\u00EDnk", "ck", "sk"];

const a_2: AmongTable = [
    ["in", 2],
    ["ov", 1],
    ["\u016Fv", 1]
];

const a_3: AmongTable = [
    ["", 2],
    ["l", 1, 1],
    ["tl", 2, 1],
    ["s", 1, 3],
    ["es", 2, 1],
    ["\u010D", 1, 5],
    ["e\u010D", 2, 1],
    ["\u0159", 1, 7],
    ["\u017E", 1, 8]
];

const as_3: readonly string[] = ["", "et"];

const a_4: AmongTable = [
    ["obl", -1],
    ["sn", -1],
    ["dot", -1]
];

const a_5: AmongTable = [
    ["uc", -1],
    ["h", -1],
    ["ok", -1],
    ["kar", -1],
    ["\u010D", -1]
];

const a_6: AmongTable = [
    ["a", 1],
    ["ama", 1, 1],
    ["ata", 1, 2],
    ["eb", 4],
    ["ec", 5],
    ["e", 2],
    ["ete", 3, 1],
    ["\u011Bte", 1, 2],
    ["ech", 2],
    ["atech", 1, 1],
    ["\u00E1ch", 1],
    ["\u00EDch", 12],
    ["\u00FDch", 1],
    ["i", 12],
    ["mi", 1, 1],
    ["ami", 1, 1],
    ["emi", 2, 2],
    ["\u00EDmi", 12, 3],
    ["\u00FDmi", 1, 4],
    ["\u011Bmi", 1, 5],
    ["\u0165mi", 11, 6],
    ["eti", 3, 8],
    ["\u011Bti", 1, 9],
    ["ovi", 1, 10],
    ["ek", 6],
    ["\u011Bk", 7],
    ["em", 2],
    ["etem", 3, 1],
    ["\u011Btem", 1, 2],
    ["\u00E1m", 1],
    ["\u00E9m", 1],
    ["\u00EDm", 12],
    ["\u00FDm", 1],
    ["\u011Bm", 1],
    ["\u016Fm", 1],
    ["at\u016Fm", 1, 1],
    ["o", 1],
    ["\u00E9ho", 1, 1],
    ["\u00EDho", 12, 2],
    ["us", 1],
    ["at", 1],
    ["et", 9],
    ["u", 1],
    ["\u00E9mu", 1, 1],
    ["\u00EDmu", 12, 2],
    ["ou", 1, 3],
    ["ev", 10],
    ["y", 1],
    ["aty", 1, 1],
    ["\u00E1", 1],
    ["\u00E9", 1],
    ["ov\u00E9", 1, 1],
    ["\u00ED", 12],
    ["\u00FD", 1],
    ["\u011B", 1],
    ["e\u0148", 8],
    ["\u0165", 11],
    ["\u016F", 1]
];

const g_v: readonly number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 4, 18, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64];

const g_v_or_syllabic_c: readonly number[] = [17, 73, 18, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 4, 18, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64];

const g_ev_ending: readonly number[] = [73, 20, 4];

const g_env_ending: readonly number[] = [71, 66, 23, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 16];


export class CzechStemmer extends BaseStemmer {

    #I_p1 = 0;


    /** @return {boolean} */
    #r_mark_regions() {
        let I_x: number;
        const v_1 = this.c;
        if (this.c + 3 > this.limit) return false;
        this.c += 3;
        I_x = this.c;
        this.c = v_1;
        this.#I_p1 = this.limit;
        const v_2 = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                // deno-lint-ignore no-unused-labels
                lab2: {
                    if (!(this.in_grouping(g_v, 97, 367))) break lab2;
                    break lab1;
                }
                if (this.c >= this.limit) break lab0;
                this.c++;
                if (!this.go_out_grouping(g_v_or_syllabic_c, 97, 367)) break lab0;
                this.c++;
            }
            if (!this.go_in_grouping(g_v, 97, 367)) break lab0;
            this.c++;
            this.#I_p1 = this.c;
            // deno-lint-ignore no-unused-labels
            lab3: {
                if (this.#I_p1 >= I_x) break lab3;
                this.#I_p1 = I_x;
            }
        }
        this.c = v_2;
        return true;
    }

    /** @return {boolean} */
    #r_palatalise_e() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_0);
        if (a === 0) return false;
        this.bra = this.c;
        if (a > 0) {
            this.slice_from(substitution(as_0, a - 1));
        }
        return true;
    }

    /** @return {boolean} */
    #r_palatalise_i() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_1);
        if (a === 0) return false;
        this.bra = this.c;
        if (a > 0) {
            this.slice_from(substitution(as_1, a - 1));
        }
        return true;
    }

    /** @return {boolean} */
    #r_possessive_suffix() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_2);
        if (a === 0) return false;
        this.bra = this.c;
        if (this.#I_p1 > this.c) return false;
        switch (a) {
            case 1: {
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_del();
                const v_1 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab0: {
                    if (!this.#r_palatalise_i()) {
                        this.c = this.limit - v_1;
                        break lab0;
                    }
                }
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_case_suffix() {
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
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_del();
                const v_2 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab0: {
                    if (!this.#r_palatalise_e()) {
                        this.c = this.limit - v_2;
                        break lab0;
                    }
                }
                break;
            }
            case 3: {
                a = this.find_among_b(a_3);
                this.slice_from(substitution(as_3, a - 1));
                break;
            }
            case 4: {
                const v_3 = this.limit - this.c;
                if (!(this.out_grouping_b(g_v, 97, 367))) return false;
                this.c = this.limit - v_3;
                // deno-lint-ignore no-unused-labels
                lab1: {
                    if (!(this.eq_s_b("t\u0159"))) break lab1;
                    return false;
                }
                this.slice_from("b");
                break;
            }
            case 5: {
                const v_4 = this.limit - this.c;
                if (!(this.out_grouping_b(g_v, 97, 367))) return false;
                this.c = this.limit - v_4;
                this.slice_del();
                this.insert(this.c, this.c, "c");
                const v_5 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    if (!this.#r_palatalise_e()) {
                        this.c = this.limit - v_5;
                        break lab2;
                    }
                }
                break;
            }
            case 6: {
                const v_6 = this.limit - this.c;
                if (!(this.out_grouping_b(g_v, 97, 367))) return false;
                this.c = this.limit - v_6;
                {
                    const v_7 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        if (this.find_among_b(a_4) === 0) break lab3;
                        return false;
                    }
                    this.c = this.limit - v_7;
                }
                this.slice_from("k");
                break;
            }
            case 7: {
                if (!(this.eq_s_b("n"))) return false;
                this.bra = this.c;
                this.slice_from("\u0148k");
                break;
            }
            case 8: {
                const v_8 = this.limit - this.c;
                if (!(this.in_grouping_b(g_env_ending, 98, 382))) return false;
                this.c = this.limit - v_8;
                this.slice_from("n");
                break;
            }
            case 9: {
                if (this.find_among_b(a_5) === 0) return false;
                this.slice_from("t");
                break;
            }
            case 10: {
                if (!(this.in_grouping_b(g_ev_ending, 104, 122))) return false;
                this.slice_from("v");
                break;
            }
            case 11: {
                this.slice_from("t");
                break;
            }
            case 12: {
                this.slice_del();
                const v_9 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab4: {
                    if (!this.#r_palatalise_i()) {
                        this.c = this.limit - v_9;
                        break lab4;
                    }
                }
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #stem() {
        if (!this.#r_mark_regions()) return false;
        this.limit_backward = this.c; this.c = this.limit;
        const v_1 = this.limit - this.c;
        this.#r_case_suffix();
        this.c = this.limit - v_1;
        const v_2 = this.limit - this.c;
        this.#r_possessive_suffix();
        this.c = this.limit - v_2;
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
