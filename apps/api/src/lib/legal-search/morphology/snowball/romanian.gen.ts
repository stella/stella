/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/romanian.sbl -js -o romanian
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

// Generated from romanian.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["\u015F", 1],
    ["\u0163", 2]
];

const as_0: readonly string[] = ["\u0219", "\u021B"];

const a_1: AmongTable = [
    ["", 3],
    ["I", 1, 1],
    ["U", 2, 2]
];

const a_2: AmongTable = [
    ["ea", 3],
    ["a\u021Bia", 7],
    ["aua", 2],
    ["iua", 4],
    ["a\u021Bie", 7],
    ["ele", 3],
    ["ile", 5],
    ["iile", 4, 1],
    ["iei", 4],
    ["atei", 6],
    ["ii", 4],
    ["ului", 1],
    ["ul", 1],
    ["elor", 3],
    ["ilor", 4],
    ["iilor", 4, 1]
];

const a_3: AmongTable = [
    ["icala", 4],
    ["iciva", 4],
    ["ativa", 5],
    ["itiva", 6],
    ["icale", 4],
    ["a\u021Biune", 5],
    ["i\u021Biune", 6],
    ["atoare", 5],
    ["itoare", 6],
    ["\u0103toare", 5],
    ["icitate", 4],
    ["abilitate", 1],
    ["ibilitate", 2],
    ["ivitate", 3],
    ["icive", 4],
    ["ative", 5],
    ["itive", 6],
    ["icali", 4],
    ["atori", 5],
    ["icatori", 4, 1],
    ["itori", 6],
    ["\u0103tori", 5],
    ["icitati", 4],
    ["abilitati", 1],
    ["ivitati", 3],
    ["icivi", 4],
    ["ativi", 5],
    ["itivi", 6],
    ["icit\u0103i", 4],
    ["abilit\u0103i", 1],
    ["ivit\u0103i", 3],
    ["icit\u0103\u021Bi", 4],
    ["abilit\u0103\u021Bi", 1],
    ["ivit\u0103\u021Bi", 3],
    ["ical", 4],
    ["ator", 5],
    ["icator", 4, 1],
    ["itor", 6],
    ["\u0103tor", 5],
    ["iciv", 4],
    ["ativ", 5],
    ["itiv", 6],
    ["ical\u0103", 4],
    ["iciv\u0103", 4],
    ["ativ\u0103", 5],
    ["itiv\u0103", 6]
];

const as_3: readonly string[] = ["abil", "ibil", "iv", "ic", "at", "it"];

const a_4: AmongTable = [
    ["ica", 1],
    ["abila", 1],
    ["ibila", 1],
    ["oasa", 1],
    ["ata", 1],
    ["ita", 1],
    ["anta", 1],
    ["ista", 3],
    ["uta", 1],
    ["iva", 1],
    ["ic", 1],
    ["ice", 1],
    ["abile", 1],
    ["ibile", 1],
    ["isme", 3],
    ["iune", 2],
    ["oase", 1],
    ["ate", 1],
    ["itate", 1, 1],
    ["ite", 1],
    ["ante", 1],
    ["iste", 3],
    ["ute", 1],
    ["ive", 1],
    ["ici", 1],
    ["abili", 1],
    ["ibili", 1],
    ["iuni", 2],
    ["atori", 1],
    ["osi", 1],
    ["ati", 1],
    ["itati", 1, 1],
    ["iti", 1],
    ["anti", 1],
    ["isti", 3],
    ["uti", 1],
    ["i\u0219ti", 3],
    ["ivi", 1],
    ["it\u0103i", 1],
    ["o\u0219i", 1],
    ["it\u0103\u021Bi", 1],
    ["abil", 1],
    ["ibil", 1],
    ["ism", 3],
    ["ator", 1],
    ["os", 1],
    ["at", 1],
    ["it", 1],
    ["ant", 1],
    ["ist", 3],
    ["ut", 1],
    ["iv", 1],
    ["ic\u0103", 1],
    ["abil\u0103", 1],
    ["ibil\u0103", 1],
    ["oas\u0103", 1],
    ["at\u0103", 1],
    ["it\u0103", 1],
    ["ant\u0103", 1],
    ["ist\u0103", 3],
    ["ut\u0103", 1],
    ["iv\u0103", 1]
];

const a_5: AmongTable = [
    ["ea", 1],
    ["ia", 1],
    ["esc", 1],
    ["\u0103sc", 1],
    ["ind", 1],
    ["\u00E2nd", 1],
    ["are", 1],
    ["ere", 1],
    ["ire", 1],
    ["\u00E2re", 1],
    ["se", 2],
    ["ase", 1, 1],
    ["sese", 2, 2],
    ["ise", 1, 3],
    ["use", 1, 4],
    ["\u00E2se", 1, 5],
    ["e\u0219te", 1],
    ["\u0103\u0219te", 1],
    ["eze", 1],
    ["ai", 1],
    ["eai", 1, 1],
    ["iai", 1, 2],
    ["sei", 2],
    ["e\u0219ti", 1],
    ["\u0103\u0219ti", 1],
    ["ui", 1],
    ["ezi", 1],
    ["\u00E2i", 1],
    ["a\u0219i", 1],
    ["se\u0219i", 2],
    ["ase\u0219i", 1, 1],
    ["sese\u0219i", 2, 2],
    ["ise\u0219i", 1, 3],
    ["use\u0219i", 1, 4],
    ["\u00E2se\u0219i", 1, 5],
    ["i\u0219i", 1],
    ["u\u0219i", 1],
    ["\u00E2\u0219i", 1],
    ["a\u021Bi", 2],
    ["ea\u021Bi", 1, 1],
    ["ia\u021Bi", 1, 2],
    ["e\u021Bi", 2],
    ["i\u021Bi", 2],
    ["\u00E2\u021Bi", 2],
    ["ar\u0103\u021Bi", 1],
    ["ser\u0103\u021Bi", 2],
    ["aser\u0103\u021Bi", 1, 1],
    ["seser\u0103\u021Bi", 2, 2],
    ["iser\u0103\u021Bi", 1, 3],
    ["user\u0103\u021Bi", 1, 4],
    ["\u00E2ser\u0103\u021Bi", 1, 5],
    ["ir\u0103\u021Bi", 1],
    ["ur\u0103\u021Bi", 1],
    ["\u00E2r\u0103\u021Bi", 1],
    ["am", 1],
    ["eam", 1, 1],
    ["iam", 1, 2],
    ["em", 2],
    ["asem", 1, 1],
    ["sesem", 2, 2],
    ["isem", 1, 3],
    ["usem", 1, 4],
    ["\u00E2sem", 1, 5],
    ["im", 2],
    ["\u00E2m", 2],
    ["\u0103m", 2],
    ["ar\u0103m", 1, 1],
    ["ser\u0103m", 2, 2],
    ["aser\u0103m", 1, 1],
    ["seser\u0103m", 2, 2],
    ["iser\u0103m", 1, 3],
    ["user\u0103m", 1, 4],
    ["\u00E2ser\u0103m", 1, 5],
    ["ir\u0103m", 1, 8],
    ["ur\u0103m", 1, 9],
    ["\u00E2r\u0103m", 1, 10],
    ["au", 1],
    ["eau", 1, 1],
    ["iau", 1, 2],
    ["indu", 1],
    ["\u00E2ndu", 1],
    ["ez", 1],
    ["easc\u0103", 1],
    ["ar\u0103", 1],
    ["ser\u0103", 2],
    ["aser\u0103", 1, 1],
    ["seser\u0103", 2, 2],
    ["iser\u0103", 1, 3],
    ["user\u0103", 1, 4],
    ["\u00E2ser\u0103", 1, 5],
    ["ir\u0103", 1],
    ["ur\u0103", 1],
    ["\u00E2r\u0103", 1],
    ["eaz\u0103", 1]
];

const a_6: AmongTable = [
    ["a", 1],
    ["e", 1],
    ["ie", 1, 1],
    ["i", 1],
    ["\u0103", 1]
];

const g_v: readonly number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 32, 0, 0, 4];


export class RomanianStemmer extends BaseStemmer {

    #B_standard_suffix_removed = false;
    #I_p2 = 0;
    #I_p1 = 0;
    #I_pV = 0;


    /** @return {boolean} */
    #r_norm() {
        let a: number;
        const v_1 = this.c;
        {
            while (true) {
                const v_2 = this.c;
                // deno-lint-ignore no-unused-labels
                lab1: {
                    // deno-lint-ignore no-unused-labels
                    golab2: while (true)
                    {
                        const v_3 = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab3: {
                            this.bra = this.c;
                            a = this.find_among(a_0);
                            if (a === 0) break lab3;
                            this.ket = this.c;
                            this.slice_from(substitution(as_0, a - 1));
                            this.c = v_3;
                            break golab2;
                        }
                        this.c = v_3;
                        if (this.c >= this.limit) break lab1;
                        this.c++;
                    }
                    continue;
                }
                this.c = v_2;
                break;
            }
        }
        this.c = v_1;
        return true;
    }

    /** @return {boolean} */
    #r_prelude() {
        while (true) {
            const v_1 = this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                // deno-lint-ignore no-unused-labels
                golab1: while (true)
                {
                    const v_2 = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab2: {
                        if (!(this.in_grouping(g_v, 97, 259))) break lab2;
                        this.bra = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab3: {
                            const v_3 = this.c;
                            // deno-lint-ignore no-unused-labels
                            lab4: {
                                if (!(this.eq_s("u"))) break lab4;
                                this.ket = this.c;
                                if (!(this.in_grouping(g_v, 97, 259))) break lab4;
                                this.slice_from("U");
                                break lab3;
                            }
                            this.c = v_3;
                            if (!(this.eq_s("i"))) break lab2;
                            this.ket = this.c;
                            if (!(this.in_grouping(g_v, 97, 259))) break lab2;
                            this.slice_from("I");
                        }
                        this.c = v_2;
                        break golab1;
                    }
                    this.c = v_2;
                    if (this.c >= this.limit) break lab0;
                    this.c++;
                }
                continue;
            }
            this.c = v_1;
            break;
        }
        return true;
    }

    /** @return {boolean} */
    #r_mark_regions() {
        this.#I_pV = this.limit;
        this.#I_p1 = this.limit;
        this.#I_p2 = this.limit;
        const v_1 = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                const v_2 = this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    if (!(this.in_grouping(g_v, 97, 259))) break lab2;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        const v_3 = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab4: {
                            if (!(this.out_grouping(g_v, 97, 259))) break lab4;
                            if (!this.go_out_grouping(g_v, 97, 259)) break lab4;
                            this.c++;
                            break lab3;
                        }
                        this.c = v_3;
                        if (!(this.in_grouping(g_v, 97, 259))) break lab2;
                        if (!this.go_in_grouping(g_v, 97, 259)) break lab2;
                        this.c++;
                    }
                    break lab1;
                }
                this.c = v_2;
                if (!(this.out_grouping(g_v, 97, 259))) break lab0;
                // deno-lint-ignore no-unused-labels
                lab5: {
                    const v_4 = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab6: {
                        if (!(this.out_grouping(g_v, 97, 259))) break lab6;
                        if (!this.go_out_grouping(g_v, 97, 259)) break lab6;
                        this.c++;
                        break lab5;
                    }
                    this.c = v_4;
                    if (!(this.in_grouping(g_v, 97, 259))) break lab0;
                    if (this.c >= this.limit) break lab0;
                    this.c++;
                }
            }
            this.#I_pV = this.c;
        }
        this.c = v_1;
        const v_5 = this.c;
        // deno-lint-ignore no-unused-labels
        lab7: {
            if (!this.go_out_grouping(g_v, 97, 259)) break lab7;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 259)) break lab7;
            this.c++;
            this.#I_p1 = this.c;
            if (!this.go_out_grouping(g_v, 97, 259)) break lab7;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 259)) break lab7;
            this.c++;
            this.#I_p2 = this.c;
        }
        this.c = v_5;
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
                        this.slice_from("i");
                        break;
                    }
                    case 2: {
                        this.slice_from("u");
                        break;
                    }
                    case 3: {
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
    #r_step_0() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_2);
        if (a === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
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
                this.slice_from("e");
                break;
            }
            case 4: {
                this.slice_from("i");
                break;
            }
            case 5: {
                // deno-lint-ignore no-unused-labels
                lab0: {
                    if (!(this.eq_s_b("ab"))) break lab0;
                    return false;
                }
                this.slice_from("i");
                break;
            }
            case 6: {
                this.slice_from("at");
                break;
            }
            case 7: {
                this.slice_from("a\u021Bi");
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_combo_suffix() {
        let a: number;
        const v_1 = this.limit - this.c;
        this.ket = this.c;
        a = this.find_among_b(a_3);
        if (a === 0) return false;
        this.bra = this.c;
        if (!this.#r_R1()) return false;
        this.slice_from(substitution(as_3, a - 1));
        this.#B_standard_suffix_removed = true;
        this.c = this.limit - v_1;
        return true;
    }

    /** @return {boolean} */
    #r_standard_suffix() {
        let a: number;
        this.#B_standard_suffix_removed = false;
        while (true) {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                if (!this.#r_combo_suffix()) break lab0;
                continue;
            }
            this.c = this.limit - v_1;
            break;
        }
        this.ket = this.c;
        a = this.find_among_b(a_4);
        if (a === 0) return false;
        this.bra = this.c;
        if (this.#I_p2 > this.c) return false;
        switch (a) {
            case 1: {
                this.slice_del();
                break;
            }
            case 2: {
                if (!(this.eq_s_b("\u021B"))) return false;
                this.bra = this.c;
                this.slice_from("t");
                break;
            }
            case 3: {
                this.slice_from("ist");
                break;
            }
        }
        this.#B_standard_suffix_removed = true;
        return true;
    }

    /** @return {boolean} */
    #r_verb_suffix() {
        let a: number;
        if (this.c < this.#I_pV) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_pV;
        this.ket = this.c;
        a = this.find_among_b(a_5);
        if (a === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        switch (a) {
            case 1: {
                // deno-lint-ignore no-unused-labels
                lab0: {
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        if (!(this.out_grouping_b(g_v, 97, 259))) break lab1;
                        break lab0;
                    }
                    if (!(this.eq_s_b("u"))) {
                        this.limit_backward = v_1;
                        return false;
                    }
                }
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_del();
                break;
            }
        }
        this.limit_backward = v_1;
        return true;
    }

    /** @return {boolean} */
    #r_vowel_suffix() {
        this.ket = this.c;
        if (this.find_among_b(a_6) === 0) return false;
        this.bra = this.c;
        if (this.#I_pV > this.c) return false;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #stem() {
        this.#r_norm();
        const v_1 = this.c;
        this.#r_prelude();
        this.c = v_1;
        this.#r_mark_regions();
        this.limit_backward = this.c; this.c = this.limit;
        const v_2 = this.limit - this.c;
        this.#r_step_0();
        this.c = this.limit - v_2;
        const v_3 = this.limit - this.c;
        this.#r_standard_suffix();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                // deno-lint-ignore no-unused-labels
                lab2: {
                    if (!this.#B_standard_suffix_removed) break lab2;
                    break lab1;
                }
                if (!this.#r_verb_suffix()) break lab0;
            }
        }
        this.c = this.limit - v_4;
        const v_5 = this.limit - this.c;
        this.#r_vowel_suffix();
        this.c = this.limit - v_5;
        this.c = this.limit_backward;
        const v_6 = this.c;
        this.#r_postlude();
        this.c = v_6;
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
