/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/german.sbl -js -o german
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

// Generated from german.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["", 5],
    ["ae", 2, 1],
    ["oe", 3, 2],
    ["qu", -1, 3],
    ["ue", 4, 4],
    ["\u00DF", 1, 5]
];

const a_1: AmongTable = [
    ["", 5],
    ["U", 2, 1],
    ["Y", 1, 2],
    ["\u00E4", 3, 3],
    ["\u00F6", 4, 4],
    ["\u00FC", 2, 5]
];

const a_2: AmongTable = [
    ["e", 3],
    ["em", 1],
    ["en", 3],
    ["erinnen", 2, 1],
    ["erin", 2],
    ["ln", 5],
    ["ern", 2],
    ["er", 2],
    ["s", 4],
    ["es", 3, 1],
    ["lns", 5, 2]
];

const a_3: AmongTable = [
    ["tick", -1],
    ["plan", -1],
    ["geordn", -1],
    ["intern", -1],
    ["tr", -1]
];

const a_4: AmongTable = [
    ["en", 1],
    ["er", 1],
    ["et", 3],
    ["st", 2],
    ["est", 1, 1]
];

const a_5: AmongTable = [
    ["ig", 1],
    ["lich", 1]
];

const a_6: AmongTable = [
    ["end", 1],
    ["ig", 2],
    ["ung", 1],
    ["lich", 3],
    ["isch", 2],
    ["ik", 2],
    ["heit", 3],
    ["keit", 4]
];

const a_7: AmongTable = [
    ["'", 1],
    ["'sch", 1],
    ["'s", 1]
];

const g_v: readonly number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 32, 8];

const g_et_ending: readonly number[] = [1, 128, 198, 227, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128];

const g_s_ending: readonly number[] = [117, 30, 5];

const g_st_ending: readonly number[] = [117, 30, 4];


export class GermanStemmer extends BaseStemmer {

    #I_p2 = 0;
    #I_p1 = 0;


    /** @return {boolean} */
    #r_prelude() {
        let a: number;
        const v_1 = this.c;
        while (true) {
            const v_2 = this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                // deno-lint-ignore no-unused-labels
                golab1: while (true)
                {
                    const v_3 = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab2: {
                        if (!(this.in_grouping(g_v, 97, 252))) break lab2;
                        this.bra = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab3: {
                            const v_4 = this.c;
                            // deno-lint-ignore no-unused-labels
                            lab4: {
                                if (!(this.eq_s("u"))) break lab4;
                                this.ket = this.c;
                                if (!(this.in_grouping(g_v, 97, 252))) break lab4;
                                this.slice_from("U");
                                break lab3;
                            }
                            this.c = v_4;
                            if (!(this.eq_s("y"))) break lab2;
                            this.ket = this.c;
                            if (!(this.in_grouping(g_v, 97, 252))) break lab2;
                            this.slice_from("Y");
                        }
                        this.c = v_3;
                        break golab1;
                    }
                    this.c = v_3;
                    if (this.c >= this.limit) break lab0;
                    this.c++;
                }
                continue;
            }
            this.c = v_2;
            break;
        }
        this.c = v_1;
        while (true) {
            const v_5 = this.c;
            // deno-lint-ignore no-unused-labels
            lab5: {
                this.bra = this.c;
                a = this.find_among(a_0);
                this.ket = this.c;
                switch (a) {
                    case 1: {
                        this.slice_from("ss");
                        break;
                    }
                    case 2: {
                        this.slice_from("\u00E4");
                        break;
                    }
                    case 3: {
                        this.slice_from("\u00F6");
                        break;
                    }
                    case 4: {
                        this.slice_from("\u00FC");
                        break;
                    }
                    case 5: {
                        if (this.c >= this.limit) break lab5;
                        this.c++;
                        break;
                    }
                }
                continue;
            }
            this.c = v_5;
            break;
        }
        return true;
    }

    /** @return {boolean} */
    #r_mark_regions() {
        let I_x: number;
        this.#I_p1 = this.limit;
        this.#I_p2 = this.limit;
        const v_1 = this.c;
        if (this.c + 3 > this.limit) return false;
        this.c += 3;
        I_x = this.c;
        this.c = v_1;
        if (!this.go_out_grouping(g_v, 97, 252)) return false;
        this.c++;
        if (!this.go_in_grouping(g_v, 97, 252)) return false;
        this.c++;
        this.#I_p1 = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            if (this.#I_p1 >= I_x) break lab0;
            this.#I_p1 = I_x;
        }
        if (!this.go_out_grouping(g_v, 97, 252)) return false;
        this.c++;
        if (!this.go_in_grouping(g_v, 97, 252)) return false;
        this.c++;
        this.#I_p2 = this.c;
        return true;
    }

    /** @return {boolean} */
    #r_postlude() {
        let a: number;
        while (true) {
            const v_1 = this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                this.bra = this.c;
                a = this.find_among(a_1);
                this.ket = this.c;
                switch (a) {
                    case 1: {
                        this.slice_from("y");
                        break;
                    }
                    case 2: {
                        this.slice_from("u");
                        break;
                    }
                    case 3: {
                        this.slice_from("a");
                        break;
                    }
                    case 4: {
                        this.slice_from("o");
                        break;
                    }
                    case 5: {
                        if (this.c >= this.limit) break lab0;
                        this.c++;
                        break;
                    }
                }
                continue;
            }
            this.c = v_1;
            break;
        }
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
    #r_standard_suffix() {
        let a: number;
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.ket = this.c;
            a = this.find_among_b(a_2);
            if (a === 0) break lab0;
            this.bra = this.c;
            if (!this.#r_R1()) break lab0;
            switch (a) {
                case 1: {
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        if (!(this.eq_s_b("syst"))) break lab1;
                        break lab0;
                    }
                    this.slice_del();
                    break;
                }
                case 2: {
                    this.slice_del();
                    break;
                }
                case 3: {
                    this.slice_del();
                    const v_2 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab2: {
                        this.ket = this.c;
                        if (!(this.eq_s_b("s"))) {
                            this.c = this.limit - v_2;
                            break lab2;
                        }
                        this.bra = this.c;
                        if (!(this.eq_s_b("nis"))) {
                            this.c = this.limit - v_2;
                            break lab2;
                        }
                        this.slice_del();
                    }
                    break;
                }
                case 4: {
                    if (!(this.in_grouping_b(g_s_ending, 98, 116))) break lab0;
                    this.slice_del();
                    break;
                }
                case 5: {
                    this.slice_from("l");
                    break;
                }
            }
        }
        this.c = this.limit - v_1;
        const v_3 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab3: {
            this.ket = this.c;
            a = this.find_among_b(a_4);
            if (a === 0) break lab3;
            this.bra = this.c;
            if (!this.#r_R1()) break lab3;
            switch (a) {
                case 1: {
                    this.slice_del();
                    break;
                }
                case 2: {
                    if (!(this.in_grouping_b(g_st_ending, 98, 116))) break lab3;
                    if (this.c - 3 < this.limit_backward) break lab3;
                    this.c -= 3;
                    this.slice_del();
                    break;
                }
                case 3: {
                    const v_4 = this.limit - this.c;
                    if (!(this.in_grouping_b(g_et_ending, 85, 228))) break lab3;
                    this.c = this.limit - v_4;
                    {
                        const v_5 = this.limit - this.c;
                        // deno-lint-ignore no-unused-labels
                        lab4: {
                            if (this.find_among_b(a_3) === 0) break lab4;
                            break lab3;
                        }
                        this.c = this.limit - v_5;
                    }
                    this.slice_del();
                    break;
                }
            }
        }
        this.c = this.limit - v_3;
        const v_6 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab5: {
            this.ket = this.c;
            a = this.find_among_b(a_6);
            if (a === 0) break lab5;
            this.bra = this.c;
            if (!this.#r_R2()) break lab5;
            switch (a) {
                case 1: {
                    this.slice_del();
                    const v_7 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab6: {
                        this.ket = this.c;
                        if (!(this.eq_s_b("ig"))) {
                            this.c = this.limit - v_7;
                            break lab6;
                        }
                        this.bra = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab7: {
                            if (!(this.eq_s_b("e"))) break lab7;
                            this.c = this.limit - v_7;
                            break lab6;
                        }
                        if (!this.#r_R2()) {
                            this.c = this.limit - v_7;
                            break lab6;
                        }
                        this.slice_del();
                    }
                    break;
                }
                case 2: {
                    // deno-lint-ignore no-unused-labels
                    lab8: {
                        if (!(this.eq_s_b("e"))) break lab8;
                        break lab5;
                    }
                    this.slice_del();
                    break;
                }
                case 3: {
                    this.slice_del();
                    const v_8 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab9: {
                        this.ket = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab10: {
                            // deno-lint-ignore no-unused-labels
                            lab11: {
                                if (!(this.eq_s_b("er"))) break lab11;
                                break lab10;
                            }
                            if (!(this.eq_s_b("en"))) {
                                this.c = this.limit - v_8;
                                break lab9;
                            }
                        }
                        this.bra = this.c;
                        if (!this.#r_R1()) {
                            this.c = this.limit - v_8;
                            break lab9;
                        }
                        this.slice_del();
                    }
                    break;
                }
                case 4: {
                    this.slice_del();
                    const v_9 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab12: {
                        this.ket = this.c;
                        if (this.find_among_b(a_5) === 0) {
                            this.c = this.limit - v_9;
                            break lab12;
                        }
                        this.bra = this.c;
                        if (!this.#r_R2()) {
                            this.c = this.limit - v_9;
                            break lab12;
                        }
                        this.slice_del();
                    }
                    break;
                }
            }
        }
        this.c = this.limit - v_6;
        const v_10 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab13: {
            this.ket = this.c;
            if (this.find_among_b(a_7) === 0) break lab13;
            this.bra = this.c;
            if (this.c <= this.limit_backward) break lab13;
            this.c--;
            if (this.c <= this.limit_backward) break lab13;
            this.slice_del();
        }
        this.c = this.limit - v_10;
        return true;
    }

    /** @return {boolean} */
    #stem() {
        const v_1 = this.c;
        this.#r_prelude();
        this.c = v_1;
        const v_2 = this.c;
        this.#r_mark_regions();
        this.c = v_2;
        this.limit_backward = this.c; this.c = this.limit;
        this.#r_standard_suffix();
        this.c = this.limit_backward;
        const v_3 = this.c;
        this.#r_postlude();
        this.c = v_3;
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
