/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/hungarian.sbl -js -o hungarian
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

// Generated from hungarian.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["\u00E1", 1],
    ["\u00E9", 2]
];

const as_0: readonly string[] = ["a", "e"];

const a_1: AmongTable = [
    ["bb", -1],
    ["cc", -1],
    ["dd", -1],
    ["ff", -1],
    ["gg", -1],
    ["jj", -1],
    ["kk", -1],
    ["ll", -1],
    ["mm", -1],
    ["nn", -1],
    ["pp", -1],
    ["rr", -1],
    ["ccs", -1],
    ["ss", -1],
    ["zzs", -1],
    ["tt", -1],
    ["vv", -1],
    ["ggy", -1],
    ["lly", -1],
    ["nny", -1],
    ["tty", -1],
    ["ssz", -1],
    ["zz", -1]
];

const a_2: AmongTable = [
    ["al", 1],
    ["el", 1]
];

const a_3: AmongTable = [
    ["ba", -1],
    ["ra", -1],
    ["be", -1],
    ["re", -1],
    ["ig", -1],
    ["nak", -1],
    ["nek", -1],
    ["val", -1],
    ["vel", -1],
    ["ul", -1],
    ["n\u00E1l", -1],
    ["n\u00E9l", -1],
    ["b\u00F3l", -1],
    ["r\u00F3l", -1],
    ["t\u00F3l", -1],
    ["\u00FCl", -1],
    ["b\u0151l", -1],
    ["r\u0151l", -1],
    ["t\u0151l", -1],
    ["n", -1],
    ["an", -1, 1],
    ["ban", -1, 1],
    ["en", -1, 3],
    ["ben", -1, 1],
    ["k\u00E9ppen", -1, 2],
    ["on", -1, 6],
    ["\u00F6n", -1, 7],
    ["k\u00E9pp", -1],
    ["kor", -1],
    ["t", -1],
    ["at", -1, 1],
    ["et", -1, 2],
    ["k\u00E9nt", -1, 3],
    ["ank\u00E9nt", -1, 1],
    ["enk\u00E9nt", -1, 2],
    ["onk\u00E9nt", -1, 3],
    ["ot", -1, 7],
    ["\u00E9rt", -1, 8],
    ["\u00F6t", -1, 9],
    ["hez", -1],
    ["hoz", -1],
    ["h\u00F6z", -1],
    ["v\u00E1", -1],
    ["v\u00E9", -1]
];

const a_4: AmongTable = [
    ["\u00E1n", 2],
    ["\u00E9n", 1],
    ["\u00E1nk\u00E9nt", 2]
];

const as_4: readonly string[] = ["e", "a"];

const a_5: AmongTable = [
    ["stul", 1],
    ["astul", 1, 1],
    ["\u00E1stul", 2, 2],
    ["st\u00FCl", 1],
    ["est\u00FCl", 1, 1],
    ["\u00E9st\u00FCl", 3, 2]
];

const as_5: readonly string[] = ["", "a", "e"];

const a_6: AmongTable = [
    ["\u00E1", 1],
    ["\u00E9", 1]
];

const a_7: AmongTable = [
    ["k", 3],
    ["ak", 3, 1],
    ["ek", 3, 2],
    ["ok", 3, 3],
    ["\u00E1k", 1, 4],
    ["\u00E9k", 2, 5],
    ["\u00F6k", 3, 6]
];

const as_7: readonly string[] = ["a", "e", ""];

const a_8: AmongTable = [
    ["\u00E9i", 1],
    ["\u00E1\u00E9i", 3, 1],
    ["\u00E9\u00E9i", 2, 2],
    ["\u00E9", 1],
    ["k\u00E9", 1, 1],
    ["ak\u00E9", 1, 1],
    ["ek\u00E9", 1, 2],
    ["ok\u00E9", 1, 3],
    ["\u00E1k\u00E9", 3, 4],
    ["\u00E9k\u00E9", 2, 5],
    ["\u00F6k\u00E9", 1, 6],
    ["\u00E9\u00E9", 2, 8]
];

const as_8: readonly string[] = ["", "e", "a"];

const a_9: AmongTable = [
    ["a", 1],
    ["ja", 1, 1],
    ["d", 1],
    ["ad", 1, 1],
    ["ed", 1, 2],
    ["od", 1, 3],
    ["\u00E1d", 2, 4],
    ["\u00E9d", 3, 5],
    ["\u00F6d", 1, 6],
    ["e", 1],
    ["je", 1, 1],
    ["nk", 1],
    ["unk", 1, 1],
    ["\u00E1nk", 2, 2],
    ["\u00E9nk", 3, 3],
    ["\u00FCnk", 1, 4],
    ["uk", 1],
    ["juk", 1, 1],
    ["\u00E1juk", 2, 1],
    ["\u00FCk", 1],
    ["j\u00FCk", 1, 1],
    ["\u00E9j\u00FCk", 3, 1],
    ["m", 1],
    ["am", 1, 1],
    ["em", 1, 2],
    ["om", 1, 3],
    ["\u00E1m", 2, 4],
    ["\u00E9m", 3, 5],
    ["o", 1],
    ["\u00E1", 2],
    ["\u00E9", 3]
];

const as_9: readonly string[] = ["", "a", "e"];

const a_10: AmongTable = [
    ["id", 1],
    ["aid", 1, 1],
    ["jaid", 1, 1],
    ["eid", 1, 3],
    ["jeid", 1, 1],
    ["\u00E1id", 2, 5],
    ["\u00E9id", 3, 6],
    ["i", 1],
    ["ai", 1, 1],
    ["jai", 1, 1],
    ["ei", 1, 3],
    ["jei", 1, 1],
    ["\u00E1i", 2, 5],
    ["\u00E9i", 3, 6],
    ["itek", 1],
    ["eitek", 1, 1],
    ["jeitek", 1, 1],
    ["\u00E9itek", 3, 3],
    ["ik", 1],
    ["aik", 1, 1],
    ["jaik", 1, 1],
    ["eik", 1, 3],
    ["jeik", 1, 1],
    ["\u00E1ik", 2, 5],
    ["\u00E9ik", 3, 6],
    ["ink", 1],
    ["aink", 1, 1],
    ["jaink", 1, 1],
    ["eink", 1, 3],
    ["jeink", 1, 1],
    ["\u00E1ink", 2, 5],
    ["\u00E9ink", 3, 6],
    ["aitok", 1],
    ["jaitok", 1, 1],
    ["\u00E1itok", 2],
    ["im", 1],
    ["aim", 1, 1],
    ["jaim", 1, 1],
    ["eim", 1, 3],
    ["jeim", 1, 1],
    ["\u00E1im", 2, 5],
    ["\u00E9im", 3, 6]
];

const as_10: readonly string[] = ["", "a", "e"];

const g_v: readonly number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 36, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1];


export class HungarianStemmer extends BaseStemmer {

    #I_p1 = 0;


    /** @return {boolean} */
    #r_mark_regions() {
        this.#I_p1 = this.limit;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.in_grouping(g_v, 97, 369))) break lab1;
                const v_2 = this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    if (!this.go_in_grouping(g_v, 97, 369)) break lab2;
                    this.c++;
                    this.#I_p1 = this.c;
                }
                this.c = v_2;
                break lab0;
            }
            this.c = v_1;
            if (!this.go_out_grouping(g_v, 97, 369)) return false;
            this.c++;
            this.#I_p1 = this.c;
        }
        return true;
    }

    /** @return {boolean} */
    #r_R1() {
        return this.#I_p1 <= this.c;
    }

    /** @return {boolean} */
    #r_v_ending() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_0);
        if (a === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        this.slice_from(substitution(as_0, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_double() {
        const v_1 = this.limit - this.c;
        if (this.find_among_b(a_1) === 0) return false;
        this.c = this.limit - v_1;
        return true;
    }

    /** @return {boolean} */
    #r_undouble() {
        if (this.c <= this.limit_backward) return false;
        this.c--;
        this.ket = this.c;
        if (this.c <= this.limit_backward) return false;
        this.c--;
        this.bra = this.c;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_instrum() {
        this.ket = this.c;
        if (this.find_among_b(a_2) === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        if (!this.#r_double()) return false;
        this.slice_del();
        return this.#r_undouble();
    }

    /** @return {boolean} */
    #r_case() {
        this.ket = this.c;
        if (this.find_among_b(a_3) === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        this.slice_del();
        return this.#r_v_ending();
    }

    /** @return {boolean} */
    #r_case_special() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_4);
        if (a === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        this.slice_from(substitution(as_4, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_case_other() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_5);
        if (a === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        this.slice_from(substitution(as_5, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_factive() {
        this.ket = this.c;
        if (this.find_among_b(a_6) === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        if (!this.#r_double()) return false;
        this.slice_del();
        return this.#r_undouble();
    }

    /** @return {boolean} */
    #r_plural() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_7);
        if (a === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        this.slice_from(substitution(as_7, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_owned() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_8);
        if (a === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        this.slice_from(substitution(as_8, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_sing_owner() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_9);
        if (a === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        this.slice_from(substitution(as_9, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_plur_owner() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_10);
        if (a === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        this.slice_from(substitution(as_10, a - 1));
        return true;
    }

    /** @return {boolean} */
    #stem() {
        const v_1 = this.c;
        this.#r_mark_regions();
        this.c = v_1;
        this.limit_backward = this.c; this.c = this.limit;
        const v_2 = this.limit - this.c;
        this.#r_instrum();
        this.c = this.limit - v_2;
        const v_3 = this.limit - this.c;
        this.#r_case();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        this.#r_case_special();
        this.c = this.limit - v_4;
        const v_5 = this.limit - this.c;
        this.#r_case_other();
        this.c = this.limit - v_5;
        const v_6 = this.limit - this.c;
        this.#r_factive();
        this.c = this.limit - v_6;
        const v_7 = this.limit - this.c;
        this.#r_owned();
        this.c = this.limit - v_7;
        const v_8 = this.limit - this.c;
        this.#r_sing_owner();
        this.c = this.limit - v_8;
        const v_9 = this.limit - this.c;
        this.#r_plur_owner();
        this.c = this.limit - v_9;
        const v_10 = this.limit - this.c;
        this.#r_plural();
        this.c = this.limit - v_10;
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
