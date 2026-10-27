// Generated from somali.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0 = [
    ["aa", 1],
    ["naa", 1, 1],
    ["doonaa", 1, 1],
    ["aynaynaa", 1, 2],
    ["aysaa", 1, 4],
    ["naysaa", 1, 1],
    ["doonaysaa", 1, 1],
    ["taa", 1, 7],
    ["doontaa", 1, 1],
    ["ayaa", 1, 9],
    ["doonayaa", 1, 1],
    ["aynayaa", 1, 2],
    ["ba", 1],
    ["da", 1],
    ["aada", 1, 1],
    ["yada", 1, 2],
    ["dayada", 1, 1],
    ["dayda", 1, 4],
    ["tayda", 1, 5],
    ["ga", 1],
    ["hayga", 1, 1],
    ["kayga", 1, 2],
    ["aha", 1],
    ["haha", 1, 1],
    ["yaha", 1, 2],
    ["sha", 1],
    ["yaasha", 1, 1],
    ["ka", 1],
    ["aanka", 1, 1],
    ["iinka", 1, 2],
    ["na", 1],
    ["ayna", 1, 1],
    ["kiisa", 1],
    ["tiisa", 1],
    ["ta", 1],
    ["ya", 1],
    ["naya", 1, 1],
    ["ood", 1],
    ["e", 1],
    ["se", 1, 1],
    ["dii", 1],
    ["gii", 1],
    ["kii", 1],
    ["tii", 1],
    ["yaal", 1],
    ["aan", 1],
    ["naan", 1, 1],
    ["ayaan", 1, 2],
    ["nayaan", 1, 1],
    ["doonayaan", 1, 1],
    ["aysan", 1],
    ["een", 1],
    ["teen", 1, 1],
    ["in", 1],
    ["yin", 1, 1],
    ["oon", 1],
    ["o", 1],
    ["yo", 1, 1],
    ["nayo", 1, 1],
    ["du", 1],
    ["gu", 1],
    ["ku", 1],
    ["su", 1],
    ["tu", 1],
    ["ay", 1],
    ["hay", 1, 1],
    ["nay", 1, 2],
    ["tay", 1, 3],
    ["yay", 1, 4],
    ["ayay", 1, 1],
    ["ayey", 1]
];

import B from './base-stemmer.js'

export default class extends B {

    #I_p1/**@type {number}*/ = 0;


    /** @return {boolean} */
    #r_Suffix() {
        this.ket = this.c;
        if (this.find_among_b(a_0) === 0) return false;
        this.bra = this.c;
        if (/**@type {boolean}*/(this.#I_p1 > this.c)) return false;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #stem() {
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.#I_p1 = this.limit;
            const /**@type {number}*/ v_1 = this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (this.c + 3 > this.limit) break lab1;
                this.c += 3;
                this.#I_p1 = this.c;
            }
            this.c = v_1;
        }
        this.limit_backward = this.c; this.c = this.limit;
        const /**@type {number}*/ v_2 = this.limit - this.c;
        this.#r_Suffix();
        this.c = this.limit - v_2;
        const /**@type {number}*/ v_3 = this.limit - this.c;
        this.#r_Suffix();
        this.c = this.limit - v_3;
        this.c = this.limit_backward;
        return true;
    }

    /**@return{string}*/
    stem(/**@type {string}*/input) {
        this.setCurrent(input);
        this.#stem();
        return this.getCurrent();
    }

    stemWord = this.stem;
}

