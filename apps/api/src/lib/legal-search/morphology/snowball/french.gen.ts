/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/french.sbl -js -o french
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

// Generated from french.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["col", -1],
    ["ni", 1],
    ["par", -1],
    ["tap", -1]
];

const a_1: AmongTable = [
    ["", 7],
    ["H", 6, 1],
    ["He", 4, 1],
    ["Hi", 5, 2],
    ["I", 1, 4],
    ["U", 2, 5],
    ["Y", 3, 6]
];

const a_2: AmongTable = [
    ["iqU", 3],
    ["abl", 3],
    ["I\u00E8r", 4],
    ["i\u00E8r", 4],
    ["eus", 2],
    ["iv", 1]
];

const a_3: AmongTable = [
    ["ic", 2],
    ["abil", 1],
    ["iv", 3]
];

const a_4: AmongTable = [
    ["iqUe", 1],
    ["atrice", 2],
    ["ance", 1],
    ["ence", 5],
    ["logie", 3],
    ["able", 1],
    ["isme", 1],
    ["euse", 12],
    ["iste", 1],
    ["ive", 8],
    ["if", 8],
    ["usion", 4],
    ["ation", 2],
    ["ution", 4],
    ["ateur", 2],
    ["iqUes", 1],
    ["atrices", 2],
    ["ances", 1],
    ["ences", 5],
    ["logies", 3],
    ["ables", 1],
    ["ismes", 1],
    ["euses", 12],
    ["istes", 1],
    ["ives", 8],
    ["ifs", 8],
    ["usions", 4],
    ["ations", 2],
    ["utions", 4],
    ["ateurs", 2],
    ["ments", 16],
    ["ements", 6, 1],
    ["issements", 13, 1],
    ["it\u00E9s", 7],
    ["ment", 16],
    ["ement", 6, 1],
    ["issement", 13, 1],
    ["amment", 14, 3],
    ["emment", 15, 4],
    ["aux", 10],
    ["eaux", 9, 1],
    ["eux", 1],
    ["oux", 11],
    ["it\u00E9", 7]
];

const a_5: AmongTable = [
    ["ira", 1],
    ["ie", 1],
    ["isse", 1],
    ["issante", 1],
    ["i", 1],
    ["irai", 1, 1],
    ["ir", 1],
    ["iras", 1],
    ["ies", 1],
    ["\u00EEmes", 1],
    ["isses", 1],
    ["issantes", 1],
    ["\u00EEtes", 1],
    ["is", 1],
    ["irais", 1, 1],
    ["issais", 1, 2],
    ["irions", 1],
    ["issions", 1],
    ["irons", 1],
    ["issons", 1],
    ["issants", 1],
    ["it", 1],
    ["irait", 1, 1],
    ["issait", 1, 2],
    ["issant", 1],
    ["iraIent", 1],
    ["issaIent", 1],
    ["irent", 1],
    ["issent", 1],
    ["iront", 1],
    ["\u00EEt", 1],
    ["iriez", 1],
    ["issiez", 1],
    ["irez", 1],
    ["issez", 1]
];

const a_6: AmongTable = [
    ["al", 1],
    ["\u00E9pl", -1],
    ["auv", -1]
];

const a_7: AmongTable = [
    ["a", 3],
    ["era", 2, 1],
    ["aise", 4],
    ["asse", 3],
    ["ante", 3],
    ["\u00E9e", 2],
    ["ai", 3],
    ["erai", 2, 1],
    ["er", 2],
    ["as", 3],
    ["eras", 2, 1],
    ["\u00E2mes", 3],
    ["aises", 4],
    ["asses", 3],
    ["antes", 3],
    ["\u00E2tes", 3],
    ["\u00E9es", 2],
    ["ais", 4],
    ["eais", 2, 1],
    ["erais", 2, 2],
    ["ions", 1],
    ["erions", 2, 1],
    ["assions", 3, 2],
    ["erons", 2],
    ["ants", 3],
    ["\u00E9s", 2],
    ["ait", 3],
    ["erait", 2, 1],
    ["ant", 3],
    ["aIent", 3],
    ["eraIent", 2, 1],
    ["\u00E8rent", 2],
    ["assent", 3],
    ["eront", 2],
    ["\u00E2t", 3],
    ["ez", 2],
    ["iez", 2, 1],
    ["eriez", 2, 1],
    ["assiez", 3, 2],
    ["erez", 2, 4],
    ["\u00E9", 2]
];

const a_8: AmongTable = [
    ["e", 3],
    ["I\u00E8re", 2, 1],
    ["i\u00E8re", 2, 2],
    ["ion", 1],
    ["Ier", 2],
    ["ier", 2]
];

const a_9: AmongTable = [
    ["ell", -1],
    ["eill", -1],
    ["enn", -1],
    ["onn", -1],
    ["ett", -1]
];

const g_v: readonly number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 130, 103, 8, 5];

const g_oux_ending: readonly number[] = [65, 85];

const g_elision_char: readonly number[] = [131, 14, 3];

const g_keep_with_s: readonly number[] = [1, 65, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128];


export class FrenchStemmer extends BaseStemmer {

    #I_p2 = 0;
    #I_p1 = 0;
    #I_pV = 0;


    /** @return {boolean} */
    #r_elisions() {
        this.bra = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.in_grouping(g_elision_char, 99, 116))) break lab1;
                break lab0;
            }
            if (!(this.eq_s("qu"))) return false;
        }
        if (!(this.eq_s("'"))) return false;
        this.ket = this.c;
        if (this.c >= this.limit) return false;
        this.slice_del();
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
                        // deno-lint-ignore no-unused-labels
                        lab3: {
                            const v_3 = this.c;
                            // deno-lint-ignore no-unused-labels
                            lab4: {
                                if (!(this.in_grouping(g_v, 97, 251))) break lab4;
                                this.bra = this.c;
                                // deno-lint-ignore no-unused-labels
                                lab5: {
                                    const v_4 = this.c;
                                    // deno-lint-ignore no-unused-labels
                                    lab6: {
                                        if (!(this.eq_s("u"))) break lab6;
                                        this.ket = this.c;
                                        if (!(this.in_grouping(g_v, 97, 251))) break lab6;
                                        this.slice_from("U");
                                        break lab5;
                                    }
                                    this.c = v_4;
                                    // deno-lint-ignore no-unused-labels
                                    lab7: {
                                        if (!(this.eq_s("i"))) break lab7;
                                        this.ket = this.c;
                                        if (!(this.in_grouping(g_v, 97, 251))) break lab7;
                                        this.slice_from("I");
                                        break lab5;
                                    }
                                    this.c = v_4;
                                    if (!(this.eq_s("y"))) break lab4;
                                    this.ket = this.c;
                                    this.slice_from("Y");
                                }
                                break lab3;
                            }
                            this.c = v_3;
                            // deno-lint-ignore no-unused-labels
                            lab8: {
                                this.bra = this.c;
                                if (!(this.eq_s("\u00EB"))) break lab8;
                                this.ket = this.c;
                                this.slice_from("He");
                                break lab3;
                            }
                            this.c = v_3;
                            // deno-lint-ignore no-unused-labels
                            lab9: {
                                this.bra = this.c;
                                if (!(this.eq_s("\u00EF"))) break lab9;
                                this.ket = this.c;
                                this.slice_from("Hi");
                                break lab3;
                            }
                            this.c = v_3;
                            // deno-lint-ignore no-unused-labels
                            lab10: {
                                this.bra = this.c;
                                if (!(this.eq_s("y"))) break lab10;
                                this.ket = this.c;
                                if (!(this.in_grouping(g_v, 97, 251))) break lab10;
                                this.slice_from("Y");
                                break lab3;
                            }
                            this.c = v_3;
                            if (!(this.eq_s("q"))) break lab2;
                            this.bra = this.c;
                            if (!(this.eq_s("u"))) break lab2;
                            this.ket = this.c;
                            this.slice_from("U");
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
        let a: number;
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
                    if (!(this.in_grouping(g_v, 97, 251))) break lab2;
                    if (!(this.in_grouping(g_v, 97, 251))) break lab2;
                    if (this.c >= this.limit) break lab2;
                    this.c++;
                    break lab1;
                }
                this.c = v_2;
                // deno-lint-ignore no-unused-labels
                lab3: {
                    a = this.find_among(a_0);
                    if (a === 0) break lab3;
                    switch (a) {
                        case 1: {
                            if (!(this.in_grouping(g_v, 97, 251))) break lab3;
                            break;
                        }
                    }
                    break lab1;
                }
                this.c = v_2;
                if (this.c >= this.limit) break lab0;
                this.c++;
                if (!this.go_out_grouping(g_v, 97, 251)) break lab0;
                this.c++;
            }
            this.#I_pV = this.c;
        }
        this.c = v_1;
        const v_3 = this.c;
        // deno-lint-ignore no-unused-labels
        lab4: {
            if (!this.go_out_grouping(g_v, 97, 251)) break lab4;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 251)) break lab4;
            this.c++;
            this.#I_p1 = this.c;
            if (!this.go_out_grouping(g_v, 97, 251)) break lab4;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 251)) break lab4;
            this.c++;
            this.#I_p2 = this.c;
        }
        this.c = v_3;
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
                        this.slice_from("y");
                        break;
                    }
                    case 4: {
                        this.slice_from("\u00EB");
                        break;
                    }
                    case 5: {
                        this.slice_from("\u00EF");
                        break;
                    }
                    case 6: {
                        this.slice_del();
                        break;
                    }
                    case 7: {
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
    #r_RV() {
        return this.#I_pV <= this.c;
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
        this.ket = this.c;
        a = this.find_among_b(a_4);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                break;
            }
            case 2: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                const v_1 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab0: {
                    this.ket = this.c;
                    if (!(this.eq_s_b("ic"))) {
                        this.c = this.limit - v_1;
                        break lab0;
                    }
                    this.bra = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        const v_2 = this.limit - this.c;
                        // deno-lint-ignore no-unused-labels
                        lab2: {
                            if (!this.#r_R2()) break lab2;
                            this.slice_del();
                            break lab1;
                        }
                        this.c = this.limit - v_2;
                        this.slice_from("iqU");
                    }
                }
                break;
            }
            case 3: {
                if (!this.#r_R2()) return false;
                this.slice_from("log");
                break;
            }
            case 4: {
                if (!this.#r_R2()) return false;
                this.slice_from("u");
                break;
            }
            case 5: {
                if (!this.#r_R2()) return false;
                this.slice_from("ent");
                break;
            }
            case 6: {
                if (!this.#r_RV()) return false;
                this.slice_del();
                const v_3 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab3: {
                    this.ket = this.c;
                    a = this.find_among_b(a_2);
                    if (a === 0) {
                        this.c = this.limit - v_3;
                        break lab3;
                    }
                    this.bra = this.c;
                    switch (a) {
                        case 1: {
                            if (!this.#r_R2()) {
                                this.c = this.limit - v_3;
                                break lab3;
                            }
                            this.slice_del();
                            this.ket = this.c;
                            if (!(this.eq_s_b("at"))) {
                                this.c = this.limit - v_3;
                                break lab3;
                            }
                            this.bra = this.c;
                            if (!this.#r_R2()) {
                                this.c = this.limit - v_3;
                                break lab3;
                            }
                            this.slice_del();
                            break;
                        }
                        case 2: {
                            // deno-lint-ignore no-unused-labels
                            lab4: {
                                const v_4 = this.limit - this.c;
                                // deno-lint-ignore no-unused-labels
                                lab5: {
                                    if (!this.#r_R2()) break lab5;
                                    this.slice_del();
                                    break lab4;
                                }
                                this.c = this.limit - v_4;
                                if (!this.#r_R1()) {
                                    this.c = this.limit - v_3;
                                    break lab3;
                                }
                                this.slice_from("eux");
                            }
                            break;
                        }
                        case 3: {
                            if (!this.#r_R2()) {
                                this.c = this.limit - v_3;
                                break lab3;
                            }
                            this.slice_del();
                            break;
                        }
                        case 4: {
                            if (!this.#r_RV()) {
                                this.c = this.limit - v_3;
                                break lab3;
                            }
                            this.slice_from("i");
                            break;
                        }
                    }
                }
                break;
            }
            case 7: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                const v_5 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab6: {
                    this.ket = this.c;
                    a = this.find_among_b(a_3);
                    if (a === 0) {
                        this.c = this.limit - v_5;
                        break lab6;
                    }
                    this.bra = this.c;
                    switch (a) {
                        case 1: {
                            // deno-lint-ignore no-unused-labels
                            lab7: {
                                const v_6 = this.limit - this.c;
                                // deno-lint-ignore no-unused-labels
                                lab8: {
                                    if (!this.#r_R2()) break lab8;
                                    this.slice_del();
                                    break lab7;
                                }
                                this.c = this.limit - v_6;
                                this.slice_from("abl");
                            }
                            break;
                        }
                        case 2: {
                            // deno-lint-ignore no-unused-labels
                            lab9: {
                                const v_7 = this.limit - this.c;
                                // deno-lint-ignore no-unused-labels
                                lab10: {
                                    if (!this.#r_R2()) break lab10;
                                    this.slice_del();
                                    break lab9;
                                }
                                this.c = this.limit - v_7;
                                this.slice_from("iqU");
                            }
                            break;
                        }
                        case 3: {
                            if (!this.#r_R2()) {
                                this.c = this.limit - v_5;
                                break lab6;
                            }
                            this.slice_del();
                            break;
                        }
                    }
                }
                break;
            }
            case 8: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                const v_8 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab11: {
                    this.ket = this.c;
                    if (!(this.eq_s_b("at"))) {
                        this.c = this.limit - v_8;
                        break lab11;
                    }
                    this.bra = this.c;
                    if (!this.#r_R2()) {
                        this.c = this.limit - v_8;
                        break lab11;
                    }
                    this.slice_del();
                    this.ket = this.c;
                    if (!(this.eq_s_b("ic"))) {
                        this.c = this.limit - v_8;
                        break lab11;
                    }
                    this.bra = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab12: {
                        const v_9 = this.limit - this.c;
                        // deno-lint-ignore no-unused-labels
                        lab13: {
                            if (!this.#r_R2()) break lab13;
                            this.slice_del();
                            break lab12;
                        }
                        this.c = this.limit - v_9;
                        this.slice_from("iqU");
                    }
                }
                break;
            }
            case 9: {
                this.slice_from("eau");
                break;
            }
            case 10: {
                if (!this.#r_R1()) return false;
                this.slice_from("al");
                break;
            }
            case 11: {
                if (!(this.in_grouping_b(g_oux_ending, 98, 112))) return false;
                this.slice_from("ou");
                break;
            }
            case 12: {
                // deno-lint-ignore no-unused-labels
                lab14: {
                    const v_10 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab15: {
                        if (!this.#r_R2()) break lab15;
                        this.slice_del();
                        break lab14;
                    }
                    this.c = this.limit - v_10;
                    if (!this.#r_R1()) return false;
                    this.slice_from("eux");
                }
                break;
            }
            case 13: {
                if (!this.#r_R1()) return false;
                if (!(this.out_grouping_b(g_v, 97, 251))) return false;
                this.slice_del();
                break;
            }
            case 14: {
                if (!this.#r_RV()) return false;
                this.slice_from("ant");
                return false;
            }
            case 15: {
                if (!this.#r_RV()) return false;
                this.slice_from("ent");
                return false;
            }
            case 16: {
                const v_11 = this.limit - this.c;
                if (!(this.in_grouping_b(g_v, 97, 251))) return false;
                if (!this.#r_RV()) return false;
                this.c = this.limit - v_11;
                this.slice_del();
                return false;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_i_verb_suffix() {
        if (this.c < this.#I_pV) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_pV;
        this.ket = this.c;
        if (this.find_among_b(a_5) === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            if (!(this.eq_s_b("H"))) break lab0;
            this.limit_backward = v_1;
            return false;
        }
        if (!(this.out_grouping_b(g_v, 97, 251))) {
            this.limit_backward = v_1;
            return false;
        }
        this.slice_del();
        this.limit_backward = v_1;
        return true;
    }

    /** @return {boolean} */
    #r_verb_suffix() {
        let a: number;
        if (this.c < this.#I_pV) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_pV;
        this.ket = this.c;
        a = this.find_among_b(a_7);
        if (a === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        switch (a) {
            case 1: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_del();
                break;
            }
            case 3: {
                const v_2 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab0: {
                    if (!(this.eq_s_b("e"))) {
                        this.c = this.limit - v_2;
                        break lab0;
                    }
                    if (!this.#r_RV()) {
                        this.c = this.limit - v_2;
                        break lab0;
                    }
                    this.bra = this.c;
                }
                this.slice_del();
                break;
            }
            case 4: {
                {
                    const v_3 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        a = this.find_among_b(a_6);
                        if (a === 0) break lab1;
                        switch (a) {
                            case 1: {
                                if (this.c <= this.limit_backward) break lab1;
                                this.c--;
                                if (this.c > this.limit_backward) break lab1;
                                break;
                            }
                        }
                        return false;
                    }
                    this.c = this.limit - v_3;
                }
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_residual_suffix() {
        let a: number;
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.ket = this.c;
            if (!(this.eq_s_b("s"))) {
                this.c = this.limit - v_1;
                break lab0;
            }
            this.bra = this.c;
            const v_2 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                // deno-lint-ignore no-unused-labels
                lab2: {
                    if (!(this.eq_s_b("Hi"))) break lab2;
                    break lab1;
                }
                if (!(this.out_grouping_b(g_keep_with_s, 97, 232))) {
                    this.c = this.limit - v_1;
                    break lab0;
                }
            }
            this.c = this.limit - v_2;
            this.slice_del();
        }
        if (this.c < this.#I_pV) return false;
        const v_3 = this.limit_backward;
        this.limit_backward = this.#I_pV;
        this.ket = this.c;
        a = this.find_among_b(a_8);
        if (a === 0) {
            this.limit_backward = v_3;
            return false;
        }
        this.bra = this.c;
        switch (a) {
            case 1: {
                if (!this.#r_R2()) {
                    this.limit_backward = v_3;
                    return false;
                }
                // deno-lint-ignore no-unused-labels
                lab3: {
                    // deno-lint-ignore no-unused-labels
                    lab4: {
                        if (!(this.eq_s_b("s"))) break lab4;
                        break lab3;
                    }
                    if (!(this.eq_s_b("t"))) {
                        this.limit_backward = v_3;
                        return false;
                    }
                }
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_from("i");
                break;
            }
            case 3: {
                this.slice_del();
                break;
            }
        }
        this.limit_backward = v_3;
        return true;
    }

    /** @return {boolean} */
    #r_un_double() {
        const v_1 = this.limit - this.c;
        if (this.find_among_b(a_9) === 0) return false;
        this.c = this.limit - v_1;
        this.ket = this.c;
        if (this.c <= this.limit_backward) return false;
        this.c--;
        this.bra = this.c;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_un_accent() {
        {
            let v_1 = 1;
            while (true) {
                // deno-lint-ignore no-unused-labels
                lab0: {
                    if (!(this.out_grouping_b(g_v, 97, 251))) break lab0;
                    v_1--;
                    continue;
                }
                break;
            }
            if (v_1 > 0) return false;
        }
        this.ket = this.c;
        // deno-lint-ignore no-unused-labels
        lab1: {
            // deno-lint-ignore no-unused-labels
            lab2: {
                if (!(this.eq_s_b("\u00E9"))) break lab2;
                break lab1;
            }
            if (!(this.eq_s_b("\u00E8"))) return false;
        }
        this.bra = this.c;
        this.slice_from("e");
        return true;
    }

    /** @return {boolean} */
    #stem() {
        const v_1 = this.c;
        this.#r_elisions();
        this.c = v_1;
        const v_2 = this.c;
        this.#r_prelude();
        this.c = v_2;
        this.#r_mark_regions();
        this.limit_backward = this.c; this.c = this.limit;
        const v_3 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                const v_4 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    const v_5 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        const v_6 = this.limit - this.c;
                        // deno-lint-ignore no-unused-labels
                        lab4: {
                            if (!this.#r_standard_suffix()) break lab4;
                            break lab3;
                        }
                        this.c = this.limit - v_6;
                        // deno-lint-ignore no-unused-labels
                        lab5: {
                            if (!this.#r_i_verb_suffix()) break lab5;
                            break lab3;
                        }
                        this.c = this.limit - v_6;
                        if (!this.#r_verb_suffix()) break lab2;
                    }
                    this.c = this.limit - v_5;
                    const v_7 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab6: {
                        this.ket = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab7: {
                            const v_8 = this.limit - this.c;
                            // deno-lint-ignore no-unused-labels
                            lab8: {
                                if (!(this.eq_s_b("Y"))) break lab8;
                                this.bra = this.c;
                                this.slice_from("i");
                                break lab7;
                            }
                            this.c = this.limit - v_8;
                            if (!(this.eq_s_b("\u00E7"))) {
                                this.c = this.limit - v_7;
                                break lab6;
                            }
                            this.bra = this.c;
                            this.slice_from("c");
                        }
                    }
                    break lab1;
                }
                this.c = this.limit - v_4;
                if (!this.#r_residual_suffix()) break lab0;
            }
        }
        this.c = this.limit - v_3;
        const v_9 = this.limit - this.c;
        this.#r_un_double();
        this.c = this.limit - v_9;
        const v_10 = this.limit - this.c;
        this.#r_un_accent();
        this.c = this.limit - v_10;
        this.c = this.limit_backward;
        const v_11 = this.c;
        this.#r_postlude();
        this.c = v_11;
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
