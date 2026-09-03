/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/irish.sbl -js -o irish
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

// Generated from irish.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["b'", 1],
    ["bh", 4],
    ["bhf", 2, 1],
    ["bp", 8],
    ["ch", 5],
    ["d'", 1],
    ["d'fh", 2, 1],
    ["dh", 6],
    ["dt", 9],
    ["fh", 2],
    ["gc", 5],
    ["gh", 7],
    ["h-", 1],
    ["m'", 1],
    ["mb", 4],
    ["mh", 10],
    ["n-", 1],
    ["nd", 6],
    ["ng", 7],
    ["ph", 8],
    ["sh", 3],
    ["t-", 1],
    ["th", 9],
    ["ts", 3]
];

const as_0: readonly string[] = ["", "f", "s", "b", "c", "d", "g", "p", "t", "m"];

const a_1: AmongTable = [
    ["\u00EDochta", 1],
    ["a\u00EDochta", 1, 1],
    ["ire", 2],
    ["aire", 2, 1],
    ["abh", 1],
    ["eabh", 1, 1],
    ["ibh", 1],
    ["aibh", 1, 1],
    ["amh", 1],
    ["eamh", 1, 1],
    ["imh", 1],
    ["aimh", 1, 1],
    ["\u00EDocht", 1],
    ["a\u00EDocht", 1, 1],
    ["ir\u00ED", 2],
    ["air\u00ED", 2, 1]
];

const a_2: AmongTable = [
    ["\u00F3ideacha", 6],
    ["patacha", 5],
    ["achta", 1],
    ["arcachta", 2, 1],
    ["eachta", 1, 2],
    ["grafa\u00EDochta", 4],
    ["paite", 5],
    ["ach", 1],
    ["each", 1, 1],
    ["\u00F3ideach", 6, 1],
    ["gineach", 3, 2],
    ["patach", 5, 4],
    ["grafa\u00EDoch", 4],
    ["pataigh", 5],
    ["\u00F3idigh", 6],
    ["acht\u00FAil", 1],
    ["eacht\u00FAil", 1, 1],
    ["gineas", 3],
    ["ginis", 3],
    ["acht", 1],
    ["arcacht", 2, 1],
    ["eacht", 1, 2],
    ["grafa\u00EDocht", 4],
    ["arcachta\u00ED", 2],
    ["grafa\u00EDochta\u00ED", 4]
];

const a_3: AmongTable = [
    ["imid", 1],
    ["aimid", 1, 1],
    ["\u00EDmid", 1],
    ["a\u00EDmid", 1, 1],
    ["adh", 2],
    ["eadh", 2, 1],
    ["faidh", 1],
    ["fidh", 1],
    ["\u00E1il", 2],
    ["ain", 2],
    ["tear", 2],
    ["tar", 2]
];

const g_v: readonly number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 4, 2];


export class IrishStemmer extends BaseStemmer {

    #I_p2 = 0;
    #I_p1 = 0;
    #I_pV = 0;


    /** @return {boolean} */
    #r_mark_regions() {
        this.#I_pV = this.limit;
        this.#I_p1 = this.limit;
        this.#I_p2 = this.limit;
        const v_1 = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            if (!this.go_out_grouping(g_v, 97, 250)) break lab0;
            this.c++;
            this.#I_pV = this.c;
            if (!this.go_in_grouping(g_v, 97, 250)) break lab0;
            this.c++;
            this.#I_p1 = this.c;
            if (!this.go_out_grouping(g_v, 97, 250)) break lab0;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 250)) break lab0;
            this.c++;
            this.#I_p2 = this.c;
        }
        this.c = v_1;
        return true;
    }

    /** @return {boolean} */
    #r_initial_morph() {
        let a: number;
        this.bra = this.c;
        a = this.find_among(a_0);
        if (a === 0) return false;
        this.ket = this.c;
        this.slice_from(substitution(as_0, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_R1() {
        return this.#I_p1 <= this.c;
    }

    /** @return {boolean} */
    #r_R2() {
        return this.#I_p2 <= this.c;
    }

    /** @return {boolean} */
    #r_noun_sfx() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_1);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                if (!this.#r_R1()) return false;
                this.slice_del();
                break;
            }
            case 2: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_deriv() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_2);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_from("arc");
                break;
            }
            case 3: {
                this.slice_from("gin");
                break;
            }
            case 4: {
                this.slice_from("graf");
                break;
            }
            case 5: {
                this.slice_from("paite");
                break;
            }
            case 6: {
                this.slice_from("\u00F3id");
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_verb_sfx() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_3);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                if (this.#I_pV > this.c) return false;
                this.slice_del();
                break;
            }
            case 2: {
                if (!this.#r_R1()) return false;
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #stem() {
        const v_1 = this.c;
        this.#r_initial_morph();
        this.c = v_1;
        this.#r_mark_regions();
        this.limit_backward = this.c; this.c = this.limit;
        const v_2 = this.limit - this.c;
        this.#r_noun_sfx();
        this.c = this.limit - v_2;
        const v_3 = this.limit - this.c;
        this.#r_deriv();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        this.#r_verb_sfx();
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
