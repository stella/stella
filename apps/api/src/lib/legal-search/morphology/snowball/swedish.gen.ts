/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/swedish.sbl -js -o swedish
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
} from "@/api/lib/legal-search/morphology/snowball/base-stemmer";

// Generated from swedish.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["fab", -1],
    ["h", -1],
    ["pak", -1],
    ["rak", -1],
    ["stak", -1],
    ["kom", -1],
    ["iet", -1],
    ["cit", -1],
    ["dit", -1],
    ["alit", -1],
    ["ilit", -1],
    ["mit", -1],
    ["nit", -1],
    ["pit", -1],
    ["rit", -1],
    ["sit", -1],
    ["tit", -1],
    ["uit", -1],
    ["ivit", -1],
    ["kvit", -1],
    ["xit", -1]
];

const a_1: AmongTable = [
    ["a", 1],
    ["arna", 1, 1],
    ["erna", 1, 2],
    ["heterna", 1, 1],
    ["orna", 1, 4],
    ["ad", 1],
    ["e", 1],
    ["ade", 1, 1],
    ["ande", 1, 2],
    ["arne", 1, 3],
    ["are", 1, 4],
    ["aste", 1, 5],
    ["en", 1],
    ["anden", 1, 1],
    ["aren", 1, 2],
    ["heten", 1, 3],
    ["ern", 1],
    ["ar", 1],
    ["er", 1],
    ["heter", 1, 1],
    ["or", 1],
    ["s", 2],
    ["as", 1, 1],
    ["arnas", 1, 1],
    ["ernas", 1, 2],
    ["ornas", 1, 3],
    ["es", 1, 5],
    ["ades", 1, 1],
    ["andes", 1, 2],
    ["ens", 1, 8],
    ["arens", 1, 1],
    ["hetens", 1, 2],
    ["erns", 1, 11],
    ["at", 1],
    ["et", 3],
    ["andet", 1, 1],
    ["het", 1, 2],
    ["ast", 1]
];

const a_2: AmongTable = [
    ["dd", -1],
    ["gd", -1],
    ["nn", -1],
    ["dt", -1],
    ["gt", -1],
    ["kt", -1],
    ["tt", -1]
];

const a_3: AmongTable = [
    ["ig", 1],
    ["lig", 1, 1],
    ["els", 1],
    ["fullt", 3],
    ["\u00F6st", 2]
];

const g_v: readonly number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 0, 32];

const g_s_ending: readonly number[] = [119, 127, 149];

const g_ost_ending: readonly number[] = [173, 58];


export class SwedishStemmer extends BaseStemmer {

    #I_p1 = 0;


    /** @return {boolean} */
    #r_mark_regions() {
        let I_x: number;
        this.#I_p1 = this.limit;
        const v_1 = this.c;
        if (this.c + 3 > this.limit) return false;
        this.c += 3;
        I_x = this.c;
        this.c = v_1;
        if (!this.go_out_grouping(g_v, 97, 246)) return false;
        this.c++;
        if (!this.go_in_grouping(g_v, 97, 246)) return false;
        this.c++;
        this.#I_p1 = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            if (this.#I_p1 >= I_x) break lab0;
            this.#I_p1 = I_x;
        }
        return true;
    }

    /** @return {boolean} */
    #r_et_condition() {
        const v_1 = this.limit - this.c;
        if (!(this.out_grouping_b(g_v, 97, 246))) return false;
        if (!(this.in_grouping_b(g_v, 97, 246))) return false;
        if (this.c <= this.limit_backward) return false;
        this.c = this.limit - v_1;
        {
            const v_2 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                if (this.find_among_b(a_0) === 0) break lab0;
                return false;
            }
            this.c = this.limit - v_2;
        }
        return true;
    }

    /** @return {boolean} */
    #r_main_suffix() {
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
                // deno-lint-ignore no-unused-labels
                lab0: {
                    const v_2 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        if (!(this.eq_s_b("et"))) break lab1;
                        if (!this.#r_et_condition()) break lab1;
                        this.bra = this.c;
                        break lab0;
                    }
                    this.c = this.limit - v_2;
                    if (!(this.in_grouping_b(g_s_ending, 98, 121))) return false;
                }
                this.slice_del();
                break;
            }
            case 3: {
                if (!this.#r_et_condition()) return false;
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_consonant_pair() {
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        const v_2 = this.limit - this.c;
        if (this.find_among_b(a_2) === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.c = this.limit - v_2;
        this.ket = this.c;
        if (this.c <= this.limit_backward) {
            this.limit_backward = v_1;
            return false;
        }
        this.c--;
        this.bra = this.c;
        this.slice_del();
        this.limit_backward = v_1;
        return true;
    }

    /** @return {boolean} */
    #r_other_suffix() {
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
        switch (a) {
            case 1: {
                this.slice_del();
                break;
            }
            case 2: {
                if (!(this.in_grouping_b(g_ost_ending, 105, 118))) return false;
                this.slice_from("\u00F6s");
                break;
            }
            case 3: {
                this.slice_from("full");
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #stem() {
        const v_1 = this.c;
        this.#r_mark_regions();
        this.c = v_1;
        this.limit_backward = this.c; this.c = this.limit;
        const v_2 = this.limit - this.c;
        this.#r_main_suffix();
        this.c = this.limit - v_2;
        const v_3 = this.limit - this.c;
        this.#r_consonant_pair();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        this.#r_other_suffix();
        this.c = this.limit - v_4;
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
