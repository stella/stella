/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/dutch.sbl -js -o dutch
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

// Generated from dutch.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["a", 1],
    ["e", 2],
    ["o", 1],
    ["u", 1],
    ["\u00E0", 1],
    ["\u00E1", 1],
    ["\u00E2", 1],
    ["\u00E4", 1],
    ["\u00E8", 2],
    ["\u00E9", 2],
    ["\u00EA", 2],
    ["e\u00EB", 3],
    ["i\u00EB", 4],
    ["\u00F2", 1],
    ["\u00F3", 1],
    ["\u00F4", 1],
    ["\u00F6", 1],
    ["\u00F9", 1],
    ["\u00FA", 1],
    ["\u00FB", 1],
    ["\u00FC", 1]
];

const a_1: AmongTable = [
    ["nde", 8],
    ["en", 7],
    ["s", 2],
    ["'s", 1, 1],
    ["es", 4, 2],
    ["ies", 3, 1],
    ["aus", 6, 4],
    ["\u00E9s", 5, 5]
];

const a_2: AmongTable = [
    ["de", 5],
    ["ge", 2],
    ["ische", 4],
    ["je", 1],
    ["lijke", 3],
    ["le", 9],
    ["ene", 10],
    ["re", 8],
    ["se", 7],
    ["te", 6],
    ["ieve", 11]
];

const a_3: AmongTable = [
    ["heid", 3],
    ["fie", 7],
    ["gie", 8],
    ["atie", 1],
    ["isme", 5],
    ["ing", 5],
    ["arij", 6],
    ["erij", 5],
    ["sel", 3],
    ["rder", 4],
    ["ster", 3],
    ["iteit", 2],
    ["dst", 10],
    ["tst", 9]
];

const a_4: AmongTable = [
    ["end", 9],
    ["atief", 2],
    ["erig", 9],
    ["achtig", 3],
    ["ioneel", 1],
    ["baar", 3],
    ["laar", 5],
    ["naar", 4],
    ["raar", 6],
    ["eriger", 9],
    ["achtiger", 3],
    ["lijker", 8],
    ["tant", 7],
    ["erigst", 9],
    ["achtigst", 3],
    ["lijkst", 8]
];

const a_5: AmongTable = [
    ["ig", 1],
    ["iger", 1],
    ["igst", 1]
];

const a_6: AmongTable = [
    ["ft", 2],
    ["kt", 1],
    ["pt", 3]
];

const as_6: readonly string[] = ["k", "f", "p"];

const a_7: AmongTable = [
    ["bb", 1],
    ["cc", 2],
    ["dd", 3],
    ["ff", 4],
    ["gg", 5],
    ["hh", 6],
    ["jj", 7],
    ["kk", 8],
    ["ll", 9],
    ["mm", 10],
    ["nn", 11],
    ["pp", 12],
    ["qq", 13],
    ["rr", 14],
    ["ss", 15],
    ["tt", 16],
    ["v", 4],
    ["vv", 17, 1],
    ["ww", 18],
    ["xx", 19],
    ["z", 15],
    ["zz", 20, 1]
];

const a_8: AmongTable = [
    ["d", 1],
    ["t", 2]
];

const a_9: AmongTable = [
    ["", -1],
    ["eft", 1, 1],
    ["vaa", 1, 2],
    ["val", 1, 3],
    ["vali", -1, 1],
    ["vare", 1, 5]
];

const a_10: AmongTable = [
    ["\u00EB", 1],
    ["\u00EF", 2]
];

const as_10: readonly string[] = ["e", "i"];

const a_11: AmongTable = [
    ["\u00EB", 1],
    ["\u00EF", 2]
];

const as_11: readonly string[] = ["e", "i"];

const g_E: readonly number[] = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120];

const g_AIOU: readonly number[] = [1, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 11, 120, 46, 15];

const g_AEIOU: readonly number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 139, 127, 46, 15];

const g_v: readonly number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 139, 127, 46, 15];

const g_v_WX: readonly number[] = [17, 65, 208, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 139, 127, 46, 15];


export class DutchStemmer extends BaseStemmer {

    #B_GE_removed = false;
    #I_p2 = 0;
    #I_p1 = 0;


    /** @return {boolean} */
    #r_R1() {
        return this.#I_p1 <= this.c;
    }

    /** @return {boolean} */
    #r_R2() {
        return this.#I_p2 <= this.c;
    }

    /** @return {boolean} */
    #r_V() {
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.in_grouping_b(g_v, 97, 252))) break lab1;
                break lab0;
            }
            if (!(this.eq_s_b("ij"))) return false;
        }
        this.c = this.limit - v_1;
        return true;
    }

    /** @return {boolean} */
    #r_VX() {
        const v_1 = this.limit - this.c;
        if (this.c <= this.limit_backward) return false;
        this.c--;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.in_grouping_b(g_v, 97, 252))) break lab1;
                break lab0;
            }
            if (!(this.eq_s_b("ij"))) return false;
        }
        this.c = this.limit - v_1;
        return true;
    }

    /** @return {boolean} */
    #r_C() {
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            if (!(this.eq_s_b("ij"))) break lab0;
            return false;
        }
        if (!(this.out_grouping_b(g_v, 97, 252))) return false;
        this.c = this.limit - v_1;
        return true;
    }

    /** @return {boolean} */
    #r_lengthen_V() {
        let a: number;
        let S_ch: string;
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            if (!(this.out_grouping_b(g_v_WX, 97, 252))) break lab0;
            this.ket = this.c;
            a = this.find_among_b(a_0);
            if (a === 0) break lab0;
            this.bra = this.c;
            switch (a) {
                case 1: {
                    const v_2 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        // deno-lint-ignore no-unused-labels
                        lab2: {
                            if (!(this.out_grouping_b(g_AEIOU, 97, 252))) break lab2;
                            break lab1;
                        }
                        if (this.c > this.limit_backward) break lab0;
                    }
                    this.c = this.limit - v_2;
                    S_ch = this.slice_to();
                    {
                        const c = this.c;
                        this.insert(c, c, S_ch);
                        this.c = c;
                    }
                    break;
                }
                case 2: {
                    const v_3 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        // deno-lint-ignore no-unused-labels
                        lab4: {
                            if (!(this.out_grouping_b(g_AEIOU, 97, 252))) break lab4;
                            break lab3;
                        }
                        if (this.c > this.limit_backward) break lab0;
                    }
                    {
                        const v_4 = this.limit - this.c;
                        // deno-lint-ignore no-unused-labels
                        lab5: {
                            // deno-lint-ignore no-unused-labels
                            lab6: {
                                // deno-lint-ignore no-unused-labels
                                lab7: {
                                    if (!(this.in_grouping_b(g_AIOU, 97, 252))) break lab7;
                                    break lab6;
                                }
                                if (!(this.in_grouping_b(g_E, 101, 235))) break lab5;
                                if (this.c > this.limit_backward) break lab5;
                            }
                            break lab0;
                        }
                        this.c = this.limit - v_4;
                    }
                    {
                        const v_5 = this.limit - this.c;
                        // deno-lint-ignore no-unused-labels
                        lab8: {
                            if (this.c <= this.limit_backward) break lab8;
                            this.c--;
                            if (!(this.in_grouping_b(g_AIOU, 97, 252))) break lab8;
                            if (!(this.out_grouping_b(g_AEIOU, 97, 252))) break lab8;
                            break lab0;
                        }
                        this.c = this.limit - v_5;
                    }
                    this.c = this.limit - v_3;
                    S_ch = this.slice_to();
                    {
                        const c = this.c;
                        this.insert(c, c, S_ch);
                        this.c = c;
                    }
                    break;
                }
                case 3: {
                    this.slice_from("e\u00EBe");
                    break;
                }
                case 4: {
                    this.slice_from("iee");
                    break;
                }
            }
        }
        this.c = this.limit - v_1;
        return true;
    }

    /** @return {boolean} */
    #r_Step_1() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_1);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                this.slice_del();
                break;
            }
            case 2: {
                if (!this.#r_R1()) return false;
                {
                    const v_1 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab0: {
                        if (!(this.eq_s_b("t"))) break lab0;
                        if (!this.#r_R1()) break lab0;
                        return false;
                    }
                    this.c = this.limit - v_1;
                }
                if (!this.#r_C()) return false;
                this.slice_del();
                break;
            }
            case 3: {
                if (!this.#r_R1()) return false;
                this.slice_from("ie");
                break;
            }
            case 4: {
                // deno-lint-ignore no-unused-labels
                lab1: {
                    const v_2 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab2: {
                        const v_3 = this.limit - this.c;
                        if (!(this.eq_s_b("ar"))) break lab2;
                        if (!this.#r_R1()) break lab2;
                        if (!this.#r_C()) break lab2;
                        this.c = this.limit - v_3;
                        this.slice_del();
                        this.#r_lengthen_V();
                        break lab1;
                    }
                    this.c = this.limit - v_2;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        const v_4 = this.limit - this.c;
                        if (!(this.eq_s_b("er"))) break lab3;
                        if (!this.#r_R1()) break lab3;
                        if (!this.#r_C()) break lab3;
                        this.c = this.limit - v_4;
                        this.slice_del();
                        break lab1;
                    }
                    this.c = this.limit - v_2;
                    if (!this.#r_R1()) return false;
                    if (!this.#r_C()) return false;
                    this.slice_from("e");
                }
                break;
            }
            case 5: {
                if (!this.#r_R1()) return false;
                this.slice_from("\u00E9");
                break;
            }
            case 6: {
                if (!this.#r_R1()) return false;
                if (!this.#r_V()) return false;
                this.slice_from("au");
                break;
            }
            case 7: {
                // deno-lint-ignore no-unused-labels
                lab4: {
                    const v_5 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab5: {
                        if (!(this.eq_s_b("hed"))) break lab5;
                        if (!this.#r_R1()) break lab5;
                        this.bra = this.c;
                        this.slice_from("heid");
                        break lab4;
                    }
                    this.c = this.limit - v_5;
                    // deno-lint-ignore no-unused-labels
                    lab6: {
                        if (!(this.eq_s_b("nd"))) break lab6;
                        this.slice_del();
                        break lab4;
                    }
                    this.c = this.limit - v_5;
                    // deno-lint-ignore no-unused-labels
                    lab7: {
                        if (!(this.eq_s_b("d"))) break lab7;
                        if (!this.#r_R1()) break lab7;
                        if (!this.#r_C()) break lab7;
                        this.bra = this.c;
                        this.slice_del();
                        break lab4;
                    }
                    this.c = this.limit - v_5;
                    // deno-lint-ignore no-unused-labels
                    lab8: {
                        // deno-lint-ignore no-unused-labels
                        lab9: {
                            // deno-lint-ignore no-unused-labels
                            lab10: {
                                if (!(this.eq_s_b("i"))) break lab10;
                                break lab9;
                            }
                            if (!(this.eq_s_b("j"))) break lab8;
                        }
                        if (!this.#r_V()) break lab8;
                        this.slice_del();
                        break lab4;
                    }
                    this.c = this.limit - v_5;
                    if (!this.#r_R1()) return false;
                    if (!this.#r_C()) return false;
                    this.slice_del();
                    this.#r_lengthen_V();
                }
                break;
            }
            case 8: {
                this.slice_from("nd");
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_Step_2() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_2);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                // deno-lint-ignore no-unused-labels
                lab0: {
                    const v_1 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        if (!(this.eq_s_b("'t"))) break lab1;
                        this.bra = this.c;
                        this.slice_del();
                        break lab0;
                    }
                    this.c = this.limit - v_1;
                    // deno-lint-ignore no-unused-labels
                    lab2: {
                        if (!(this.eq_s_b("et"))) break lab2;
                        this.bra = this.c;
                        if (!this.#r_R1()) break lab2;
                        if (!this.#r_C()) break lab2;
                        this.slice_del();
                        break lab0;
                    }
                    this.c = this.limit - v_1;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        if (!(this.eq_s_b("rnt"))) break lab3;
                        this.bra = this.c;
                        this.slice_from("rn");
                        break lab0;
                    }
                    this.c = this.limit - v_1;
                    // deno-lint-ignore no-unused-labels
                    lab4: {
                        if (!(this.eq_s_b("t"))) break lab4;
                        this.bra = this.c;
                        if (!this.#r_R1()) break lab4;
                        if (!this.#r_VX()) break lab4;
                        this.slice_del();
                        break lab0;
                    }
                    this.c = this.limit - v_1;
                    // deno-lint-ignore no-unused-labels
                    lab5: {
                        if (!(this.eq_s_b("ink"))) break lab5;
                        this.bra = this.c;
                        this.slice_from("ing");
                        break lab0;
                    }
                    this.c = this.limit - v_1;
                    // deno-lint-ignore no-unused-labels
                    lab6: {
                        if (!(this.eq_s_b("mp"))) break lab6;
                        this.bra = this.c;
                        this.slice_from("m");
                        break lab0;
                    }
                    this.c = this.limit - v_1;
                    // deno-lint-ignore no-unused-labels
                    lab7: {
                        if (!(this.eq_s_b("'"))) break lab7;
                        this.bra = this.c;
                        if (!this.#r_R1()) break lab7;
                        this.slice_del();
                        break lab0;
                    }
                    this.c = this.limit - v_1;
                    this.bra = this.c;
                    if (!this.#r_R1()) return false;
                    if (!this.#r_C()) return false;
                    this.slice_del();
                }
                break;
            }
            case 2: {
                if (!this.#r_R1()) return false;
                this.slice_from("g");
                break;
            }
            case 3: {
                if (!this.#r_R1()) return false;
                this.slice_from("lijk");
                break;
            }
            case 4: {
                if (!this.#r_R1()) return false;
                this.slice_from("isch");
                break;
            }
            case 5: {
                if (!this.#r_R1()) return false;
                if (!this.#r_C()) return false;
                this.slice_del();
                break;
            }
            case 6: {
                if (!this.#r_R1()) return false;
                this.slice_from("t");
                break;
            }
            case 7: {
                if (!this.#r_R1()) return false;
                this.slice_from("s");
                break;
            }
            case 8: {
                if (!this.#r_R1()) return false;
                this.slice_from("r");
                break;
            }
            case 9: {
                if (!this.#r_R1()) return false;
                this.slice_del();
                this.insert(this.c, this.c, "l");
                this.#r_lengthen_V();
                break;
            }
            case 10: {
                if (!this.#r_R1()) return false;
                if (!this.#r_C()) return false;
                this.slice_del();
                this.insert(this.c, this.c, "en");
                this.#r_lengthen_V();
                break;
            }
            case 11: {
                if (!this.#r_R1()) return false;
                if (!this.#r_C()) return false;
                this.slice_from("ief");
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_Step_3() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_3);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                if (!this.#r_R1()) return false;
                this.slice_from("eer");
                break;
            }
            case 2: {
                if (!this.#r_R1()) return false;
                this.slice_del();
                this.#r_lengthen_V();
                break;
            }
            case 3: {
                if (!this.#r_R1()) return false;
                this.slice_del();
                break;
            }
            case 4: {
                this.slice_from("r");
                break;
            }
            case 5: {
                // deno-lint-ignore no-unused-labels
                lab0: {
                    const v_1 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        if (!(this.eq_s_b("ild"))) break lab1;
                        this.slice_from("er");
                        break lab0;
                    }
                    this.c = this.limit - v_1;
                    if (!this.#r_R1()) return false;
                    this.slice_del();
                    this.#r_lengthen_V();
                }
                break;
            }
            case 6: {
                if (!this.#r_R1()) return false;
                if (!this.#r_C()) return false;
                this.slice_from("aar");
                break;
            }
            case 7: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                this.insert(this.c, this.c, "f");
                this.#r_lengthen_V();
                break;
            }
            case 8: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                this.insert(this.c, this.c, "g");
                this.#r_lengthen_V();
                break;
            }
            case 9: {
                if (!this.#r_R1()) return false;
                if (!this.#r_C()) return false;
                this.slice_from("t");
                break;
            }
            case 10: {
                if (!this.#r_R1()) return false;
                if (!this.#r_C()) return false;
                this.slice_from("d");
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_Step_4() {
        let a: number;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                this.ket = this.c;
                a = this.find_among_b(a_4);
                if (a === 0) break lab1;
                this.bra = this.c;
                switch (a) {
                    case 1: {
                        if (!this.#r_R1()) break lab1;
                        this.slice_from("ie");
                        break;
                    }
                    case 2: {
                        if (!this.#r_R1()) break lab1;
                        this.slice_from("eer");
                        break;
                    }
                    case 3: {
                        if (!this.#r_R1()) break lab1;
                        this.slice_del();
                        break;
                    }
                    case 4: {
                        if (!this.#r_R1()) break lab1;
                        if (!this.#r_V()) break lab1;
                        this.slice_from("n");
                        break;
                    }
                    case 5: {
                        if (!this.#r_R1()) break lab1;
                        if (!this.#r_V()) break lab1;
                        this.slice_from("l");
                        break;
                    }
                    case 6: {
                        if (!this.#r_R1()) break lab1;
                        if (!this.#r_V()) break lab1;
                        this.slice_from("r");
                        break;
                    }
                    case 7: {
                        if (!this.#r_R1()) break lab1;
                        this.slice_from("teer");
                        break;
                    }
                    case 8: {
                        if (!this.#r_R1()) break lab1;
                        this.slice_from("lijk");
                        break;
                    }
                    case 9: {
                        if (!this.#r_R1()) break lab1;
                        if (!this.#r_C()) break lab1;
                        this.slice_del();
                        this.#r_lengthen_V();
                        break;
                    }
                }
                break lab0;
            }
            this.c = this.limit - v_1;
            this.ket = this.c;
            if (this.find_among_b(a_5) === 0) return false;
            this.bra = this.c;
            if (!this.#r_R1()) return false;
            {
                const v_2 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    if (!(this.eq_s_b("inn"))) break lab2;
                    if (this.c > this.limit_backward) break lab2;
                    return false;
                }
                this.c = this.limit - v_2;
            }
            if (!this.#r_C()) return false;
            this.slice_del();
            this.#r_lengthen_V();
        }
        return true;
    }

    /** @return {boolean} */
    #r_Step_7() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_6);
        if (a === 0) return false;
        this.bra = this.c;
        this.slice_from(substitution(as_6, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_Step_6() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_7);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                this.slice_from("b");
                break;
            }
            case 2: {
                this.slice_from("c");
                break;
            }
            case 3: {
                this.slice_from("d");
                break;
            }
            case 4: {
                this.slice_from("f");
                break;
            }
            case 5: {
                this.slice_from("g");
                break;
            }
            case 6: {
                this.slice_from("h");
                break;
            }
            case 7: {
                this.slice_from("j");
                break;
            }
            case 8: {
                this.slice_from("k");
                break;
            }
            case 9: {
                this.slice_from("l");
                break;
            }
            case 10: {
                this.slice_from("m");
                break;
            }
            case 11: {
                {
                    const v_1 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab0: {
                        if (!(this.eq_s_b("i"))) break lab0;
                        if (this.c > this.limit_backward) break lab0;
                        return false;
                    }
                    this.c = this.limit - v_1;
                }
                this.slice_from("n");
                break;
            }
            case 12: {
                this.slice_from("p");
                break;
            }
            case 13: {
                this.slice_from("q");
                break;
            }
            case 14: {
                this.slice_from("r");
                break;
            }
            case 15: {
                this.slice_from("s");
                break;
            }
            case 16: {
                this.slice_from("t");
                break;
            }
            case 17: {
                this.slice_from("v");
                break;
            }
            case 18: {
                this.slice_from("w");
                break;
            }
            case 19: {
                this.slice_from("x");
                break;
            }
            case 20: {
                this.slice_from("z");
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_Step_1c() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_8);
        if (a === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        if (!this.#r_C()) return false;
        switch (a) {
            case 1: {
                {
                    const v_1 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab0: {
                        if (!(this.eq_s_b("n"))) break lab0;
                        if (!this.#r_R1()) break lab0;
                        return false;
                    }
                    this.c = this.limit - v_1;
                }
                // deno-lint-ignore no-unused-labels
                lab1: {
                    const v_2 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab2: {
                        if (!(this.eq_s_b("in"))) break lab2;
                        if (this.c > this.limit_backward) break lab2;
                        this.slice_from("n");
                        break lab1;
                    }
                    this.c = this.limit - v_2;
                    this.slice_del();
                }
                break;
            }
            case 2: {
                {
                    const v_3 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        if (!(this.eq_s_b("h"))) break lab3;
                        if (!this.#r_R1()) break lab3;
                        return false;
                    }
                    this.c = this.limit - v_3;
                }
                {
                    const v_4 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab4: {
                        if (!(this.eq_s_b("en"))) break lab4;
                        if (this.c > this.limit_backward) break lab4;
                        return false;
                    }
                    this.c = this.limit - v_4;
                }
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_Lose_prefix() {
        let a: number;
        this.bra = this.c;
        if (!(this.eq_s("ge"))) return false;
        this.ket = this.c;
        const v_1 = this.c;
        if (this.c + 3 > this.limit) return false;
        this.c += 3;
        this.c = v_1;
        const v_2 = this.c;
        // deno-lint-ignore no-unused-labels
        golab0: while (true)
        {
            const v_3 = this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                // deno-lint-ignore no-unused-labels
                lab2: {
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        if (!(this.eq_s("ij"))) break lab3;
                        break lab2;
                    }
                    if (!(this.in_grouping(g_v, 97, 252))) break lab1;
                }
                break golab0;
            }
            this.c = v_3;
            if (this.c >= this.limit) return false;
            this.c++;
        }
        while (true) {
            const v_4 = this.c;
            // deno-lint-ignore no-unused-labels
            lab4: {
                // deno-lint-ignore no-unused-labels
                lab5: {
                    // deno-lint-ignore no-unused-labels
                    lab6: {
                        if (!(this.eq_s("ij"))) break lab6;
                        break lab5;
                    }
                    if (!(this.in_grouping(g_v, 97, 252))) break lab4;
                }
                continue;
            }
            this.c = v_4;
            break;
        }
        if (this.c >= this.limit) return false;
        this.c = v_2;
        a = this.find_among(a_9);
        switch (a) {
            case 1: {
                return false;
            }
        }
        this.#B_GE_removed = true;
        this.slice_del();
        const v_5 = this.c;
        // deno-lint-ignore no-unused-labels
        lab7: {
            this.bra = this.c;
            a = this.find_among(a_10);
            if (a === 0) break lab7;
            this.ket = this.c;
            this.slice_from(substitution(as_10, a - 1));
        }
        this.c = v_5;
        return true;
    }

    /** @return {boolean} */
    #r_Lose_infix() {
        let a: number;
        if (this.c >= this.limit) return false;
        this.c++;
        // deno-lint-ignore no-unused-labels
        golab0: while (true)
        {
            // deno-lint-ignore no-unused-labels
            lab1: {
                this.bra = this.c;
                if (!(this.eq_s("ge"))) break lab1;
                this.ket = this.c;
                break golab0;
            }
            if (this.c >= this.limit) return false;
            this.c++;
        }
        const v_1 = this.c;
        if (this.c + 3 > this.limit) return false;
        this.c += 3;
        this.c = v_1;
        const v_2 = this.c;
        // deno-lint-ignore no-unused-labels
        golab2: while (true)
        {
            const v_3 = this.c;
            // deno-lint-ignore no-unused-labels
            lab3: {
                // deno-lint-ignore no-unused-labels
                lab4: {
                    // deno-lint-ignore no-unused-labels
                    lab5: {
                        if (!(this.eq_s("ij"))) break lab5;
                        break lab4;
                    }
                    if (!(this.in_grouping(g_v, 97, 252))) break lab3;
                }
                break golab2;
            }
            this.c = v_3;
            if (this.c >= this.limit) return false;
            this.c++;
        }
        while (true) {
            const v_4 = this.c;
            // deno-lint-ignore no-unused-labels
            lab6: {
                // deno-lint-ignore no-unused-labels
                lab7: {
                    // deno-lint-ignore no-unused-labels
                    lab8: {
                        if (!(this.eq_s("ij"))) break lab8;
                        break lab7;
                    }
                    if (!(this.in_grouping(g_v, 97, 252))) break lab6;
                }
                continue;
            }
            this.c = v_4;
            break;
        }
        if (this.c >= this.limit) return false;
        this.c = v_2;
        this.#B_GE_removed = true;
        this.slice_del();
        const v_5 = this.c;
        // deno-lint-ignore no-unused-labels
        lab9: {
            this.bra = this.c;
            a = this.find_among(a_11);
            if (a === 0) break lab9;
            this.ket = this.c;
            this.slice_from(substitution(as_11, a - 1));
        }
        this.c = v_5;
        return true;
    }

    /** @return {boolean} */
    #r_measure() {
        this.#I_p1 = this.limit;
        this.#I_p2 = this.limit;
        const v_1 = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            while (true) {
                // deno-lint-ignore no-unused-labels
                lab1: {
                    if (!(this.out_grouping(g_v, 97, 252))) break lab1;
                    continue;
                }
                break;
            }
            {
                let v_2 = 1;
                while (true) {
                    const v_3 = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab2: {
                        // deno-lint-ignore no-unused-labels
                        lab3: {
                            // deno-lint-ignore no-unused-labels
                            lab4: {
                                if (!(this.eq_s("ij"))) break lab4;
                                break lab3;
                            }
                            if (!(this.in_grouping(g_v, 97, 252))) break lab2;
                        }
                        v_2--;
                        continue;
                    }
                    this.c = v_3;
                    break;
                }
                if (v_2 > 0) break lab0;
            }
            if (!(this.out_grouping(g_v, 97, 252))) break lab0;
            this.#I_p1 = this.c;
            while (true) {
                // deno-lint-ignore no-unused-labels
                lab5: {
                    if (!(this.out_grouping(g_v, 97, 252))) break lab5;
                    continue;
                }
                break;
            }
            {
                let v_4 = 1;
                while (true) {
                    const v_5 = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab6: {
                        // deno-lint-ignore no-unused-labels
                        lab7: {
                            // deno-lint-ignore no-unused-labels
                            lab8: {
                                if (!(this.eq_s("ij"))) break lab8;
                                break lab7;
                            }
                            if (!(this.in_grouping(g_v, 97, 252))) break lab6;
                        }
                        v_4--;
                        continue;
                    }
                    this.c = v_5;
                    break;
                }
                if (v_4 > 0) break lab0;
            }
            if (!(this.out_grouping(g_v, 97, 252))) break lab0;
            this.#I_p2 = this.c;
        }
        this.c = v_1;
        return true;
    }

    /** @return {boolean} */
    #stem() {
        let B_stemmed: boolean;
        B_stemmed = false;
        this.#r_measure();
        this.limit_backward = this.c; this.c = this.limit;
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            if (!this.#r_Step_1()) break lab0;
            B_stemmed = true;
        }
        this.c = this.limit - v_1;
        const v_2 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab1: {
            if (!this.#r_Step_2()) break lab1;
            B_stemmed = true;
        }
        this.c = this.limit - v_2;
        const v_3 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab2: {
            if (!this.#r_Step_3()) break lab2;
            B_stemmed = true;
        }
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab3: {
            if (!this.#r_Step_4()) break lab3;
            B_stemmed = true;
        }
        this.c = this.limit - v_4;
        this.c = this.limit_backward;
        this.#B_GE_removed = false;
        const v_5 = this.c;
        // deno-lint-ignore no-unused-labels
        lab4: {
            const v_6 = this.c;
            if (!this.#r_Lose_prefix()) break lab4;
            this.c = v_6;
            this.#r_measure();
        }
        this.c = v_5;
        this.limit_backward = this.c; this.c = this.limit;
        const v_7 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab5: {
            if (!this.#B_GE_removed) break lab5;
            B_stemmed = true;
            if (!this.#r_Step_1c()) break lab5;
        }
        this.c = this.limit - v_7;
        this.c = this.limit_backward;
        this.#B_GE_removed = false;
        const v_8 = this.c;
        // deno-lint-ignore no-unused-labels
        lab6: {
            const v_9 = this.c;
            if (!this.#r_Lose_infix()) break lab6;
            this.c = v_9;
            this.#r_measure();
        }
        this.c = v_8;
        this.limit_backward = this.c; this.c = this.limit;
        const v_10 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab7: {
            if (!this.#B_GE_removed) break lab7;
            B_stemmed = true;
            if (!this.#r_Step_1c()) break lab7;
        }
        this.c = this.limit - v_10;
        this.c = this.limit_backward;
        this.limit_backward = this.c; this.c = this.limit;
        const v_11 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab8: {
            if (!this.#r_Step_7()) break lab8;
            B_stemmed = true;
        }
        this.c = this.limit - v_11;
        const v_12 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab9: {
            if (!B_stemmed) break lab9;
            if (!this.#r_Step_6()) break lab9;
        }
        this.c = this.limit - v_12;
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
