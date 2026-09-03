/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/danish.sbl -js -o danish
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

// Generated from danish.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["hed", 1],
    ["ethed", 1, 1],
    ["ered", 1],
    ["e", 1],
    ["erede", 1, 1],
    ["ende", 1, 2],
    ["erende", 1, 1],
    ["ene", 1, 4],
    ["erne", 1, 5],
    ["ere", 1, 6],
    ["en", 1],
    ["heden", 1, 1],
    ["eren", 1, 2],
    ["er", 1],
    ["heder", 1, 1],
    ["erer", 1, 2],
    ["s", 2],
    ["heds", 1, 1],
    ["es", 1, 2],
    ["endes", 1, 1],
    ["erendes", 1, 1],
    ["enes", 1, 3],
    ["ernes", 1, 4],
    ["eres", 1, 5],
    ["ens", 1, 8],
    ["hedens", 1, 1],
    ["erens", 1, 2],
    ["ers", 1, 11],
    ["ets", 1, 12],
    ["erets", 1, 1],
    ["et", 1],
    ["eret", 1, 1]
];

const a_1: AmongTable = [
    ["gd", -1],
    ["dt", -1],
    ["gt", -1],
    ["kt", -1]
];

const a_2: AmongTable = [
    ["ig", 1],
    ["lig", 1, 1],
    ["elig", 1, 1],
    ["els", 1],
    ["l\u00F8st", 2]
];

const g_undouble_c: readonly number[] = [53, 94, 7];

const g_v: readonly number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 48, 0, 128];

const g_s_ending: readonly number[] = [1, 0, 0, 0, 0, 0, 0, 188, 251, 171, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64];


export class DanishStemmer extends BaseStemmer {

    #I_p1 = 0;


    /** @return {boolean} */
    #r_mark_regions() {
        this.#I_p1 = this.limit;
        const v_1 = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                const v_2 = this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    // deno-lint-ignore no-unused-labels
                    golab3: while (true)
                    {
                        // deno-lint-ignore no-unused-labels
                        lab4: {
                            if (!(this.eq_s("'"))) break lab4;
                            break golab3;
                        }
                        if (this.c >= this.limit) break lab2;
                        this.c++;
                    }
                    break lab1;
                }
                this.c = v_2;
                if (!this.go_out_grouping(g_v, 97, 248)) break lab0;
                this.c++;
                if (!this.go_in_grouping(g_v, 97, 248)) break lab0;
                this.c++;
            }
            this.#I_p1 = this.c;
        }
        this.c = v_1;
        const v_3 = this.c;
        if (this.c + 3 > this.limit) return false;
        this.c += 3;
        // deno-lint-ignore no-unused-labels
        lab5: {
            if (this.#I_p1 >= this.c) break lab5;
            this.#I_p1 = this.c;
        }
        this.c = v_3;
        return true;
    }

    /** @return {boolean} */
    #r_main_suffix() {
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
        switch (a) {
            case 1: {
                this.slice_del();
                break;
            }
            case 2: {
                if (!(this.in_grouping_b(g_s_ending, 39, 229))) return false;
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_consonant_pair() {
        const v_1 = this.limit - this.c;
        if (this.c < this.#I_p1) return false;
        const v_2 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        if (this.find_among_b(a_1) === 0) {
            this.limit_backward = v_2;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_2;
        this.c = this.limit - v_1;
        if (this.c <= this.limit_backward) return false;
        this.c--;
        this.bra = this.c;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_other_suffix() {
        let a: number;
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.ket = this.c;
            if (!(this.eq_s_b("st"))) break lab0;
            this.bra = this.c;
            if (!(this.eq_s_b("ig"))) break lab0;
            this.slice_del();
        }
        this.c = this.limit - v_1;
        if (this.c < this.#I_p1) return false;
        const v_2 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        a = this.find_among_b(a_2);
        if (a === 0) {
            this.limit_backward = v_2;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_2;
        switch (a) {
            case 1: {
                this.slice_del();
                const v_3 = this.limit - this.c;
                this.#r_consonant_pair();
                this.c = this.limit - v_3;
                break;
            }
            case 2: {
                this.slice_from("l\u00F8s");
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_undouble() {
        let S_ch: string;
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        if (!(this.in_grouping_b(g_undouble_c, 98, 116))) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        S_ch = this.slice_to();
        this.limit_backward = v_1;
        if (!(this.eq_s_b(S_ch))) return false;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #stem() {
        if (!this.#r_mark_regions()) return false;
        this.limit_backward = this.c; this.c = this.limit;
        const v_1 = this.limit - this.c;
        this.#r_main_suffix();
        this.c = this.limit - v_1;
        const v_2 = this.limit - this.c;
        this.#r_consonant_pair();
        this.c = this.limit - v_2;
        const v_3 = this.limit - this.c;
        this.#r_other_suffix();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        this.#r_undouble();
        this.c = this.limit - v_4;
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
