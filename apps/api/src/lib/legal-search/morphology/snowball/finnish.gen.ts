/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/finnish.sbl -js -o finnish
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

// Generated from finnish.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["pa", 1],
    ["sti", 2],
    ["kaan", 1],
    ["han", 1],
    ["kin", 1],
    ["h\u00E4n", 1],
    ["k\u00E4\u00E4n", 1],
    ["ko", 1],
    ["p\u00E4", 1],
    ["k\u00F6", 1]
];

const a_1: AmongTable = [
    ["lla", -1],
    ["na", -1],
    ["ssa", -1],
    ["ta", -1],
    ["lta", -1, 1],
    ["sta", -1, 2]
];

const a_2: AmongTable = [
    ["ll\u00E4", -1],
    ["n\u00E4", -1],
    ["ss\u00E4", -1],
    ["t\u00E4", -1],
    ["lt\u00E4", -1, 1],
    ["st\u00E4", -1, 2]
];

const a_3: AmongTable = [
    ["lle", -1],
    ["ine", -1]
];

const a_4: AmongTable = [
    ["nsa", 3],
    ["mme", 3],
    ["nne", 3],
    ["ni", 2],
    ["si", 1],
    ["an", 4],
    ["en", 6],
    ["\u00E4n", 5],
    ["ns\u00E4", 3]
];

const a_5: AmongTable = [
    ["aa", -1],
    ["ee", -1],
    ["ii", -1],
    ["oo", -1],
    ["uu", -1],
    ["\u00E4\u00E4", -1],
    ["\u00F6\u00F6", -1]
];

const a_6: AmongTable = [
    ["'", -1],
    ["ai", -1],
    ["ei", -1],
    ["ii", -1],
    ["oi", -1],
    ["ui", -1],
    ["\u00E4i", -1],
    ["\u00F6i", -1]
];

const a_7: AmongTable = [
    ["a", 2],
    ["lla", -1, 1],
    ["na", -1, 2],
    ["ssa", -1, 3],
    ["ta", -1, 4],
    ["lta", -1, 1],
    ["sta", -1, 2],
    ["tta", 3, 3],
    ["lle", -1],
    ["ine", -1],
    ["ksi", -1],
    ["n", 1],
    ["han", -1, 1, 3],
    ["den", -1, 2, 8],
    ["seen", -1, 3, 9],
    ["hen", -1, 4, 4],
    ["tten", -1, 5, 8],
    ["hin", -1, 6, 5],
    ["siin", -1, 7, 8],
    ["hon", -1, 8, 6],
    ["hun", -1, 9, 7],
    ["h\u00E4n", -1, 10, 1],
    ["h\u00F6n", -1, 11, 2],
    ["\u00E4", 2],
    ["ll\u00E4", -1, 1],
    ["n\u00E4", -1, 2],
    ["ss\u00E4", -1, 3],
    ["t\u00E4", -1, 4],
    ["lt\u00E4", -1, 1],
    ["st\u00E4", -1, 2],
    ["tt\u00E4", 3, 3]
];

const a_8: AmongTable = [
    ["eja", -1],
    ["mma", 1],
    ["imma", -1, 1],
    ["mpa", 1],
    ["impa", -1, 1],
    ["mmi", 1],
    ["immi", -1, 1],
    ["mpi", 1],
    ["impi", -1, 1],
    ["ej\u00E4", -1],
    ["mm\u00E4", 1],
    ["imm\u00E4", -1, 1],
    ["mp\u00E4", 1],
    ["imp\u00E4", -1, 1]
];

const a_9: AmongTable = [
    ["i", -1],
    ["j", -1]
];

const a_10: AmongTable = [
    ["mma", 1],
    ["imma", -1, 1]
];

const g_AEI: readonly number[] = [17, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8];

const g_C: readonly number[] = [119, 223, 119, 1];

const g_v: readonly number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 32];

const g_particle_end: readonly number[] = [17, 97, 24, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 32];


export class FinnishStemmer extends BaseStemmer {

    #B_ending_removed = false;
    #I_p2 = 0;
    #I_p1 = 0;


    /** @return {boolean} */
    #af_7() {
        switch (this.af) {
            case 1: return this.#r_A_();
            case 2: return this.#r_O_();
            case 3: return this.#r_A();
            case 4: return this.#r_E();
            case 5: return this.#r_I();
            case 6: return this.#r_O();
            case 7: return this.#r_U();
            case 8: return this.#r_VI();
            case 9: return this.#r_LV();
        }
        return false;
    }

    /** @return {boolean} */
    #r_mark_regions() {
        this.#I_p1 = this.limit;
        this.#I_p2 = this.limit;
        if (!this.go_out_grouping(g_v, 97, 246)) return false;
        this.c++;
        if (!this.go_in_grouping(g_v, 97, 246)) return false;
        this.c++;
        this.#I_p1 = this.c;
        if (!this.go_out_grouping(g_v, 97, 246)) return false;
        this.c++;
        if (!this.go_in_grouping(g_v, 97, 246)) return false;
        this.c++;
        this.#I_p2 = this.c;
        return true;
    }

    /** @return {boolean} */
    #r_particle_etc() {
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
                if (!(this.in_grouping_b(g_particle_end, 97, 246))) return false;
                break;
            }
            case 2: {
                if (this.#I_p2 > this.c) return false;
                break;
            }
        }
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_possessive() {
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
                    if (!(this.eq_s_b("k"))) break lab0;
                    return false;
                }
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_del();
                this.ket = this.c;
                if (!(this.eq_s_b("kse"))) return false;
                this.bra = this.c;
                this.slice_from("ksi");
                break;
            }
            case 3: {
                this.slice_del();
                break;
            }
            case 4: {
                if (this.find_among_b(a_1) === 0) return false;
                this.slice_del();
                break;
            }
            case 5: {
                if (this.find_among_b(a_2) === 0) return false;
                this.slice_del();
                break;
            }
            case 6: {
                if (this.find_among_b(a_3) === 0) return false;
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_LV() {
        return this.find_among_b(a_5) !== 0;
    }

    /** @return {boolean} */
    #r_VI() {
        return this.find_among_b(a_6) !== 0;
    }

    /** @return {boolean} */
    #r_A() {
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.eq_s_b("a"))) break lab1;
                break lab0;
            }
            if (!(this.eq_s_b("'"))) return false;
        }
        return true;
    }

    /** @return {boolean} */
    #r_E() {
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.eq_s_b("e"))) break lab1;
                break lab0;
            }
            if (!(this.eq_s_b("'"))) return false;
        }
        return true;
    }

    /** @return {boolean} */
    #r_I() {
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.eq_s_b("i"))) break lab1;
                break lab0;
            }
            if (!(this.eq_s_b("'"))) return false;
        }
        return true;
    }

    /** @return {boolean} */
    #r_O() {
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.eq_s_b("o"))) break lab1;
                break lab0;
            }
            if (!(this.eq_s_b("'"))) return false;
        }
        return true;
    }

    /** @return {boolean} */
    #r_U() {
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.eq_s_b("u"))) break lab1;
                break lab0;
            }
            if (!(this.eq_s_b("'"))) return false;
        }
        return true;
    }

    /** @return {boolean} */
    #r_A_() {
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.eq_s_b("\u00E4"))) break lab1;
                break lab0;
            }
            if (!(this.eq_s_b("'"))) return false;
        }
        return true;
    }

    /** @return {boolean} */
    #r_O_() {
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.eq_s_b("\u00F6"))) break lab1;
                break lab0;
            }
            // deno-lint-ignore no-unused-labels
            lab2: {
                if (!(this.eq_s_b("\u00F8"))) break lab2;
                break lab0;
            }
            if (!(this.eq_s_b("'"))) return false;
        }
        return true;
    }

    /** @return {boolean} */
    #r_case_ending() {
        let a: number;
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        a = this.find_among_b(a_7, this.#af_7);
        if (a === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        switch (a) {
            case 1: {
                const v_2 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab0: {
                    const v_3 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        const v_4 = this.limit - this.c;
                        // deno-lint-ignore no-unused-labels
                        lab2: {
                            if (!this.#r_LV()) break lab2;
                            break lab1;
                        }
                        this.c = this.limit - v_4;
                        if (!(this.eq_s_b("ie"))) {
                            this.c = this.limit - v_2;
                            break lab0;
                        }
                    }
                    this.c = this.limit - v_3;
                    if (this.c <= this.limit_backward) {
                        this.c = this.limit - v_2;
                        break lab0;
                    }
                    this.c--;
                    this.bra = this.c;
                }
                break;
            }
            case 2: {
                if (!(this.in_grouping_b(g_v, 97, 246))) return false;
                if (!(this.in_grouping_b(g_C, 98, 122))) return false;
                break;
            }
            case 3: {
                if (!(this.eq_s_b("e"))) return false;
                break;
            }
        }
        this.slice_del();
        this.#B_ending_removed = true;
        return true;
    }

    /** @return {boolean} */
    #r_other_endings() {
        let a: number;
        if (this.c < this.#I_p2) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p2;
        this.ket = this.c;
        a = this.find_among_b(a_8);
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
                    if (!(this.eq_s_b("po"))) break lab0;
                    return false;
                }
                break;
            }
        }
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_i_plural() {
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        if (this.find_among_b(a_9) === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_t_plural() {
        let a: number;
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        if (!(this.eq_s_b("t"))) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        const v_2 = this.limit - this.c;
        if (!(this.in_grouping_b(g_v, 97, 246))) {
            this.limit_backward = v_1;
            return false;
        }
        this.c = this.limit - v_2;
        this.slice_del();
        this.limit_backward = v_1;
        if (this.c < this.#I_p2) return false;
        const v_3 = this.limit_backward;
        this.limit_backward = this.#I_p2;
        this.ket = this.c;
        a = this.find_among_b(a_10);
        if (a === 0) {
            this.limit_backward = v_3;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_3;
        switch (a) {
            case 1: {
                // deno-lint-ignore no-unused-labels
                lab0: {
                    if (!(this.eq_s_b("po"))) break lab0;
                    return false;
                }
                break;
            }
        }
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_tidy() {
        let S_x: string;
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        const v_2 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_3 = this.limit - this.c;
            if (!this.#r_LV()) break lab0;
            this.c = this.limit - v_3;
            this.ket = this.c;
            if (this.c <= this.limit_backward) break lab0;
            this.c--;
            this.bra = this.c;
            this.slice_del();
        }
        this.c = this.limit - v_2;
        const v_4 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab1: {
            this.ket = this.c;
            if (!(this.in_grouping_b(g_AEI, 97, 228))) break lab1;
            this.bra = this.c;
            if (!(this.in_grouping_b(g_C, 98, 122))) break lab1;
            this.slice_del();
        }
        this.c = this.limit - v_4;
        const v_5 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab2: {
            this.ket = this.c;
            if (!(this.eq_s_b("j"))) break lab2;
            this.bra = this.c;
            // deno-lint-ignore no-unused-labels
            lab3: {
                // deno-lint-ignore no-unused-labels
                lab4: {
                    if (!(this.eq_s_b("o"))) break lab4;
                    break lab3;
                }
                if (!(this.eq_s_b("u"))) break lab2;
            }
            this.slice_del();
        }
        this.c = this.limit - v_5;
        const v_6 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab5: {
            this.ket = this.c;
            if (!(this.eq_s_b("o"))) break lab5;
            this.bra = this.c;
            if (!(this.eq_s_b("j"))) break lab5;
            this.slice_del();
        }
        this.c = this.limit - v_6;
        this.limit_backward = v_1;
        const v_7 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab6: {
            if (!this.go_in_grouping_b(g_v, 97, 246)) break lab6;
            this.ket = this.c;
            if (!(this.in_grouping_b(g_C, 98, 122))) break lab6;
            this.bra = this.c;
            S_x = this.slice_to();
            if (!(this.eq_s_b(S_x))) break lab6;
            this.slice_del();
        }
        this.c = this.limit - v_7;
        this.ket = this.c;
        if (!(this.eq_s_b("'"))) return false;
        this.bra = this.c;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #stem() {
        const v_1 = this.c;
        this.#r_mark_regions();
        this.c = v_1;
        this.#B_ending_removed = false;
        this.limit_backward = this.c; this.c = this.limit;
        const v_2 = this.limit - this.c;
        this.#r_particle_etc();
        this.c = this.limit - v_2;
        const v_3 = this.limit - this.c;
        this.#r_possessive();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        this.#r_case_ending();
        this.c = this.limit - v_4;
        const v_5 = this.limit - this.c;
        this.#r_other_endings();
        this.c = this.limit - v_5;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!this.#B_ending_removed) break lab1;
                const v_6 = this.limit - this.c;
                this.#r_i_plural();
                this.c = this.limit - v_6;
                break lab0;
            }
            const v_7 = this.limit - this.c;
            this.#r_t_plural();
            this.c = this.limit - v_7;
        }
        const v_8 = this.limit - this.c;
        this.#r_tidy();
        this.c = this.limit - v_8;
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
