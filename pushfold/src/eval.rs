//! Seven-card hand evaluation.
//!
//! `eval7` is the fast evaluator used by the solver: bit tricks on the four
//! 13-bit suit masks plus four 8192-entry tables. It returns a value where a
//! larger number is a better hand (category in bits 20..23).
//! `naive7` is an independent reference: the best of the 21 five-card subsets,
//! each ranked by sorting and counting. Tests check the two agree in ordering
//! and that the fast evaluator reproduces the known category counts over all
//! 133,784,560 seven-card hands.

use crate::cards::{rank_of, suit_of};
use std::sync::OnceLock;

pub const HIGH_CARD: u32 = 0;
pub const PAIR: u32 = 1;
pub const TWO_PAIR: u32 = 2;
pub const TRIPS: u32 = 3;
pub const STRAIGHT: u32 = 4;
pub const FLUSH: u32 = 5;
pub const FULL_HOUSE: u32 = 6;
pub const QUADS: u32 = 7;
pub const STRAIGHT_FLUSH: u32 = 8;

struct Tables {
    straight: Vec<u8>, // top rank + 1 of the best straight in a rank mask, 0 if none
    top5: Vec<u16>,
    top3: Vec<u16>,
    top2: Vec<u16>,
    ordinal: Vec<u16>, // value -> dense ordinal (1-based), 0 for impossible values
}

fn keep_top(mut m: u32, n: u32) -> u16 {
    while m.count_ones() > n {
        m &= m - 1;
    }
    m as u16
}

fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        let mut straight = vec![0u8; 8192];
        let mut top5 = vec![0u16; 8192];
        let mut top3 = vec![0u16; 8192];
        let mut top2 = vec![0u16; 8192];
        for m in 0..8192u32 {
            let mut st = 0u8;
            for top in (4..13u32).rev() {
                let w = 0x1Fu32 << (top - 4);
                if m & w == w {
                    st = top as u8 + 1;
                    break;
                }
            }
            if st == 0 && (m & 0x100F) == 0x100F {
                st = 4; // A-2-3-4-5, top card the five (rank 3)
            }
            straight[m as usize] = st;
            top5[m as usize] = keep_top(m, 5);
            top3[m as usize] = keep_top(m, 3);
            top2[m as usize] = keep_top(m, 2);
        }
        let mut t = Tables { straight, top5, top3, top2, ordinal: Vec::new() };
        // Dense ordinal of every value a best-five-card hand can take: enumerate
        // all 2,598,960 five-card hands (the evaluator is valid for 5..7 cards).
        let mut seen = vec![false; 9 << 20];
        let mut bits = [0u64; 52];
        for (c, b) in bits.iter_mut().enumerate() {
            *b = crate::cards::eval_bit(c as u8);
        }
        for a in 0..52 {
            for b in a + 1..52 {
                for c in b + 1..52 {
                    for d in c + 1..52 {
                        let x = bits[a] | bits[b] | bits[c] | bits[d];
                        for e in d + 1..52 {
                            seen[eval_with(&t, x | bits[e]) as usize] = true;
                        }
                    }
                }
            }
        }
        let mut ordinal = vec![0u16; 9 << 20];
        let mut k = 0u16;
        for (v, &s) in seen.iter().enumerate() {
            if s {
                k += 1;
                ordinal[v] = k;
            }
        }
        t.ordinal = ordinal;
        t
    })
}

#[inline]
fn hi_bit(x: u32) -> u32 {
    31 - x.leading_zeros()
}

#[inline]
fn eval_with(t: &Tables, bits: u64) -> u32 {
    let c = (bits & 0x1FFF) as u32;
    let d = ((bits >> 16) & 0x1FFF) as u32;
    let h = ((bits >> 32) & 0x1FFF) as u32;
    let s = ((bits >> 48) & 0x1FFF) as u32;
    let ranks = c | d | h | s;
    let n_dups = bits.count_ones() - ranks.count_ones();
    for m in [c, d, h, s] {
        if m.count_ones() >= 5 {
            // With at most 7 cards a flush excludes quads and full houses.
            let st = t.straight[m as usize];
            if st != 0 {
                return (STRAIGHT_FLUSH << 20) | st as u32;
            }
            return (FLUSH << 20) | t.top5[m as usize] as u32;
        }
    }
    let st = t.straight[ranks as usize];
    if st != 0 {
        // Five distinct ranks leave at most two duplicates: no full house or quads.
        return (STRAIGHT << 20) | st as u32;
    }
    let odd = c ^ d ^ h ^ s; // ranks held an odd number of times
    match n_dups {
        0 => (HIGH_CARD << 20) | t.top5[ranks as usize] as u32,
        1 => {
            let pair = ranks ^ odd;
            let p = hi_bit(pair);
            (PAIR << 20) | (p << 13) | t.top3[(ranks & !pair) as usize] as u32
        }
        2 => {
            let even = ranks ^ odd;
            if even != 0 {
                let p1 = hi_bit(even);
                let p2 = hi_bit(even & !(1 << p1));
                let k = hi_bit(ranks & !even);
                (TWO_PAIR << 20) | (p1 << 8) | (p2 << 4) | k
            } else {
                let trip = ((c & d) | (h & s)) & ((c & h) | (d & s));
                let tr = hi_bit(trip);
                (TRIPS << 20) | (tr << 13) | t.top2[(ranks & !trip) as usize] as u32
            }
        }
        _ => {
            let quad = c & d & h & s;
            if quad != 0 {
                let q = hi_bit(quad);
                let k = hi_bit(ranks & !quad);
                return (QUADS << 20) | (q << 4) | k;
            }
            let trip = ((c & d) | (h & s)) & ((c & h) | (d & s));
            let even = ranks ^ odd;
            if trip != 0 {
                let t1 = hi_bit(trip);
                let pairs = even | (trip & !(1 << t1));
                (FULL_HOUSE << 20) | (t1 << 4) | hi_bit(pairs)
            } else {
                // three pairs: best two pairs, kicker may be the third pair
                let p1 = hi_bit(even);
                let p2 = hi_bit(even & !(1 << p1));
                let k = hi_bit(ranks & !(1 << p1) & !(1 << p2));
                (TWO_PAIR << 20) | (p1 << 8) | (p2 << 4) | k
            }
        }
    }
}

/// Evaluate 5 to 7 cards given in the suit-major bit layout (`cards::eval_bit`).
#[inline]
pub fn eval7(bits: u64) -> u32 {
    eval_with(tables(), bits)
}

/// Dense 1-based ordinal (1 = worst high card .. 7462 = royal flush) of a value.
#[inline]
pub fn ordinal(value: u32) -> u16 {
    tables().ordinal[value as usize]
}

pub fn init() {
    let _ = tables();
}

/// Category of a value from `eval7`.
#[allow(dead_code)] // used by tests
pub fn category(value: u32) -> u32 {
    value >> 20
}

// ---------------------------------------------------------------------------
// Independent reference evaluator.

/// Rank five cards: (category, tiebreak ranks high to low) packed as
/// category * 13^5 + base-13 digits. Larger is better.
pub fn naive5(cards: [u8; 5]) -> u32 {
    let mut ranks: Vec<u32> = cards.iter().map(|&c| rank_of(c) as u32).collect();
    ranks.sort_unstable_by(|a, b| b.cmp(a));
    let flush = cards.iter().all(|&c| suit_of(c) == suit_of(cards[0]));
    let distinct = {
        let mut d = ranks.clone();
        d.dedup();
        d
    };
    let mut straight_top: Option<u32> = None;
    if distinct.len() == 5 {
        if ranks[0] - ranks[4] == 4 {
            straight_top = Some(ranks[0]);
        } else if ranks == vec![12, 3, 2, 1, 0] {
            straight_top = Some(3);
        }
    }
    // group by count desc, then rank desc
    let mut groups: Vec<(u32, u32)> = distinct
        .iter()
        .map(|&r| (ranks.iter().filter(|&&x| x == r).count() as u32, r))
        .collect();
    groups.sort_unstable_by(|a, b| b.cmp(a));
    let counts: Vec<u32> = groups.iter().map(|g| g.0).collect();
    let order: Vec<u32> = groups.iter().map(|g| g.1).collect();
    let (cat, tb): (u32, Vec<u32>) = if let (Some(t), true) = (straight_top, flush) {
        (8, vec![t])
    } else if counts[0] == 4 {
        (7, order)
    } else if counts == vec![3, 2] {
        (6, order)
    } else if flush {
        (5, ranks.clone())
    } else if let Some(t) = straight_top {
        (4, vec![t])
    } else if counts[0] == 3 {
        (3, order)
    } else if counts == vec![2, 2, 1] {
        (2, order)
    } else if counts[0] == 2 {
        (1, order)
    } else {
        (0, ranks.clone())
    };
    let mut v = cat;
    for i in 0..5 {
        v = v * 13 + tb.get(i).copied().unwrap_or(0);
    }
    v
}

/// Best five of seven cards with `naive5`.
pub fn naive7(cards: [u8; 7]) -> u32 {
    let mut best = 0;
    for skip1 in 0..7 {
        for skip2 in skip1 + 1..7 {
            let mut five = [0u8; 5];
            let mut k = 0;
            for (i, &c) in cards.iter().enumerate() {
                if i != skip1 && i != skip2 {
                    five[k] = c;
                    k += 1;
                }
            }
            best = best.max(naive5(five));
        }
    }
    best
}

#[allow(dead_code)] // used by tests
pub fn naive_category(v: u32) -> u32 {
    v / 13u32.pow(5)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::{eval_bit, parse_card, Rng};

    fn bits_of(cards: &[u8]) -> u64 {
        cards.iter().fold(0, |acc, &c| acc | eval_bit(c))
    }

    fn hand(s: &str) -> Vec<u8> {
        s.split_whitespace().map(|x| parse_card(x).unwrap()).collect()
    }

    #[test]
    fn simple_categories() {
        let cases = [
            ("As Ks Qs Js Ts 2d 3c", STRAIGHT_FLUSH),
            ("5h 4h 3h 2h Ah Kd Kc", STRAIGHT_FLUSH),
            ("9c 9d 9h 9s 2d 3c 4h", QUADS),
            ("9c 9d 9h 2s 2d 3c 4h", FULL_HOUSE),
            ("9c 9d 9h 2s 2d 2c 4h", FULL_HOUSE),
            ("Ac 9c 7c 5c 2c Kd Kh", FLUSH),
            ("Ac 2d 3h 4s 5c Kd Kh", STRAIGHT),
            ("9c 9d 9h As 2d 3c 5h", TRIPS),
            ("9c 9d 2h 2s Ad 3c 5h", TWO_PAIR),
            ("9c 9d 2h 2s Ad Ac 5h", TWO_PAIR),
            ("9c 9d 2h 7s Ad Jc 5h", PAIR),
            ("9c Td 2h 7s Ad Jc 5h", HIGH_CARD),
        ];
        for (s, cat) in cases {
            let v = eval7(bits_of(&hand(s)));
            assert_eq!(category(v), cat, "{s}");
        }
        // Wheel loses to a six-high straight.
        let wheel = eval7(bits_of(&hand("Ac 2d 3h 4s 5c Kd Kh")));
        let six = eval7(bits_of(&hand("6c 2d 3h 4s 5c Kd Kh")));
        assert!(six > wheel);
        // Three pairs: kicker can come from the third pair.
        let a = eval7(bits_of(&hand("9c 9d 7h 7s 8d 8c 2h")));
        let b = eval7(bits_of(&hand("9c 9d 8h 8s 7d 2c 3h")));
        assert_eq!(a, b);
    }

    #[test]
    fn agrees_with_naive_evaluator_on_random_boards() {
        let mut rng = Rng::new(12345);
        let mut deck: Vec<u8> = (0..52).collect();
        for _ in 0..300_000 {
            crate::cards::draw(&mut deck, 52, 9, &mut rng);
            let board = &deck[43..48];
            let h1 = [deck[48], deck[49]];
            let h2 = [deck[50], deck[51]];
            let mut c1 = [0u8; 7];
            let mut c2 = [0u8; 7];
            c1[..5].copy_from_slice(board);
            c2[..5].copy_from_slice(board);
            c1[5..].copy_from_slice(&h1);
            c2[5..].copy_from_slice(&h2);
            let (f1, f2) = (eval7(bits_of(&c1)), eval7(bits_of(&c2)));
            let (n1, n2) = (naive7(c1), naive7(c2));
            assert_eq!(f1.cmp(&f2), n1.cmp(&n2), "{:?} {:?}", c1, c2);
            assert_eq!(category(f1), naive_category(n1));
        }
    }

    /// Exhaustive check over all 133,784,560 seven-card hands against the
    /// published category counts, and the number of distinct hand values (4824).
    #[test]
    fn exhaustive_seven_card_counts() {
        let bits: Vec<u64> = (0..52u8).map(eval_bit).collect();
        let mut counts = [0u64; 9];
        let mut seen = vec![false; 9 << 20];
        for a in 0..52 {
            for b in a + 1..52 {
                let x2 = bits[a] | bits[b];
                for c in b + 1..52 {
                    let x3 = x2 | bits[c];
                    for d in c + 1..52 {
                        let x4 = x3 | bits[d];
                        for e in d + 1..52 {
                            let x5 = x4 | bits[e];
                            for f in e + 1..52 {
                                let x6 = x5 | bits[f];
                                for g in f + 1..52 {
                                    let v = eval7(x6 | bits[g]);
                                    counts[category(v) as usize] += 1;
                                    seen[v as usize] = true;
                                }
                            }
                        }
                    }
                }
            }
        }
        let expected = [
            23_294_460u64, 58_627_800, 31_433_400, 6_461_620, 6_180_020, 4_047_644, 3_473_184,
            224_848, 41_584,
        ];
        assert_eq!(counts, expected);
        assert_eq!(seen.iter().filter(|&&s| s).count(), 4824);
        assert_eq!(ordinal(eval7(bits_of(&hand("As Ks Qs Js Ts 2d 3c")))), 7462);
    }
}
