//! Small 7-card hand evaluator (best 5 of 7) for the showdown sample.
//! Cards use the library encoding (4 * rank + suit, rank 0 = deuce).

const CAT_NAMES: [&str; 9] = [
    "High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house",
    "Four of a kind", "Straight flush",
];

fn rank_word(r: u8, plural: bool) -> &'static str {
    const S: [&str; 13] = ["deuce", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "jack", "queen", "king", "ace"];
    const P: [&str; 13] = ["deuces", "threes", "fours", "fives", "sixes", "sevens", "eights", "nines", "tens", "jacks", "queens", "kings", "aces"];
    if plural { P[r as usize] } else { S[r as usize] }
}

/// Value of a 5-card hand: category in bits 20.., then up to five ranks.
fn eval5(c: &[u8; 5]) -> u32 {
    let mut ranks: Vec<u8> = c.iter().map(|x| x / 4).collect();
    ranks.sort_unstable_by(|a, b| b.cmp(a));
    let flush = c.iter().all(|x| x % 4 == c[0] % 4);
    let mut uniq = ranks.clone();
    uniq.dedup();
    let straight_high = if uniq.len() == 5 {
        if ranks[0] - ranks[4] == 4 {
            Some(ranks[0])
        } else if ranks == [12, 3, 2, 1, 0] {
            Some(3) // wheel, five-high
        } else {
            None
        }
    } else {
        None
    };
    // groups sorted by (count desc, rank desc)
    let mut groups: Vec<(u8, u8)> = uniq.iter().map(|&r| (ranks.iter().filter(|&&x| x == r).count() as u8, r)).collect();
    groups.sort_unstable_by(|a, b| b.cmp(a));
    let pack = |cat: u32, rs: &[u8]| -> u32 {
        let mut v = cat << 20;
        for (k, &r) in rs.iter().enumerate() {
            v |= (r as u32) << (16 - 4 * k);
        }
        v
    };
    let grp_ranks: Vec<u8> = groups.iter().map(|g| g.1).collect();
    match (straight_high, flush, groups[0].0, groups.get(1).map(|g| g.0)) {
        (Some(h), true, _, _) => pack(8, &[h]),
        (_, _, 4, _) => pack(7, &grp_ranks),
        (_, _, 3, Some(2)) => pack(6, &grp_ranks),
        (_, true, _, _) => pack(5, &ranks),
        (Some(h), false, _, _) => pack(4, &[h]),
        (_, _, 3, _) => pack(3, &grp_ranks),
        (_, _, 2, Some(2)) => pack(2, &grp_ranks),
        (_, _, 2, _) => pack(1, &grp_ranks),
        _ => pack(0, &ranks),
    }
}

/// Best 5-card value out of 7 cards.
pub fn eval7(cards: &[u8; 7]) -> u32 {
    let mut best = 0;
    for skip1 in 0..7 {
        for skip2 in skip1 + 1..7 {
            let mut h = [0u8; 5];
            let mut k = 0;
            for (i, &c) in cards.iter().enumerate() {
                if i != skip1 && i != skip2 {
                    h[k] = c;
                    k += 1;
                }
            }
            best = best.max(eval5(&h));
        }
    }
    best
}

pub fn hand_name(v: u32) -> String {
    let cat = (v >> 20) as usize;
    let r = |k: usize| ((v >> (16 - 4 * k)) & 0xF) as u8;
    match cat {
        0 => format!("High card, {}", rank_word(r(0), false)),
        1 => format!("Pair of {}", rank_word(r(0), true)),
        2 => format!("Two pair, {} and {}", rank_word(r(0), true), rank_word(r(1), true)),
        3 => format!("Three of a kind, {}", rank_word(r(0), true)),
        4 => format!("Straight, {}-high", rank_word(r(0), false)),
        5 => format!("Flush, {}-high", rank_word(r(0), false)),
        6 => format!("Full house, {} full of {}", rank_word(r(0), true), rank_word(r(1), true)),
        7 => format!("Four of a kind, {}", rank_word(r(0), true)),
        _ => {
            if r(0) == 12 { "Royal flush".to_string() } else { format!("{}, {}-high", CAT_NAMES[8], rank_word(r(0), false)) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::parse_cards;

    fn v(s: &str) -> u32 {
        let c = parse_cards(s, 7).unwrap();
        eval7(&[c[0], c[1], c[2], c[3], c[4], c[5], c[6]])
    }

    #[test]
    fn categories_and_order() {
        assert_eq!(hand_name(v("AhQdQs7d2c5hKc")), "Pair of queens");
        assert_eq!(hand_name(v("9h8hKh7h3c2hJd")), "Flush, king-high");
        assert_eq!(hand_name(v("9h8hKh7h3c2sJd")), "High card, king");
        assert_eq!(hand_name(v("Ah2d3c4s5hKdQc")), "Straight, five-high");
        assert_eq!(hand_name(v("KsKdJh8c4d9h2c")), "Pair of kings");
        assert_eq!(hand_name(v("7s7d7h2c2dKsQs")), "Full house, sevens full of deuces");
        assert!(v("KhJdQs7d2c5hKc") > v("AhQdQs7d2c5hKc"));
        assert!(v("AhKdQs7d2c5h9c") > v("AhJdQs7d2c5h9c")); // kicker
        assert!(v("6h2d3c4s5hKdQc") > v("Ah2d3c4s5hKdQc")); // six-high straight beats wheel
        assert_eq!(v("AhKd2s3s4s5s9c"), v("AcKh2s3s4s5s9c"));
    }
}
