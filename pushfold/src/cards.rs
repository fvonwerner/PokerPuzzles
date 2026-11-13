//! Cards, two-card combos, the 169 hand classes and a seeded RNG.
//!
//! Card id = rank * 4 + suit, rank 0 = deuce .. 12 = ace, suit 0..3 = s, h, d, c.
//! Hand classes use the project's 13x13 grid order (docs/SPEC.md, web/js/poker.js):
//! with R = "AKQJT98765432", entry 13*i + j is the pair R[i]R[i] when i == j,
//! the suited class R[i]R[j]s when i < j and the offsuit class R[j]R[i]o when i > j.

use std::sync::OnceLock;

pub const RANK_CHARS: &[u8; 13] = b"23456789TJQKA";
pub const SUIT_CHARS: &[u8; 4] = b"shdc";
pub const GRID_RANKS: &[u8; 13] = b"AKQJT98765432";
pub const NUM_COMBOS: usize = 1326;
pub const NUM_CLASSES: usize = 169;

#[inline]
pub fn rank_of(c: u8) -> u8 {
    c >> 2
}
#[inline]
pub fn suit_of(c: u8) -> u8 {
    c & 3
}

/// Bit of a card in the evaluator's suit-major layout: bit (16 * suit + rank).
#[inline]
pub fn eval_bit(c: u8) -> u64 {
    1u64 << (16 * suit_of(c) as u32 + rank_of(c) as u32)
}

pub fn parse_card(s: &str) -> Option<u8> {
    let b = s.as_bytes();
    if b.len() != 2 {
        return None;
    }
    let r = RANK_CHARS.iter().position(|&x| x == b[0].to_ascii_uppercase())?;
    let su = SUIT_CHARS.iter().position(|&x| x == b[1].to_ascii_lowercase())?;
    Some((r * 4 + su) as u8)
}

/// Parse "AhKd" into two card ids.
pub fn parse_hand(s: &str) -> Option<(u8, u8)> {
    if s.len() != 4 {
        return None;
    }
    let a = parse_card(&s[0..2])?;
    let b = parse_card(&s[2..4])?;
    if a == b {
        return None;
    }
    Some((a, b))
}

/// Grid index of the class of two cards.
pub fn class_of_cards(a: u8, b: u8) -> usize {
    let (ra, rb) = (rank_of(a) as usize, rank_of(b) as usize);
    let (hi, lo) = if ra >= rb { (ra, rb) } else { (rb, ra) };
    let (ih, il) = (12 - hi, 12 - lo); // grid row of each rank
    if hi == lo {
        13 * ih + ih
    } else if suit_of(a) == suit_of(b) {
        13 * ih + il
    } else {
        13 * il + ih
    }
}

pub fn class_name(idx: usize) -> String {
    let (i, j) = (idx / 13, idx % 13);
    let r = |k: usize| GRID_RANKS[k] as char;
    if i == j {
        format!("{}{}", r(i), r(i))
    } else if i < j {
        format!("{}{}s", r(i), r(j))
    } else {
        format!("{}{}o", r(j), r(i))
    }
}

#[allow(dead_code)] // used by tests
pub fn class_index(name: &str) -> Option<usize> {
    (0..NUM_CLASSES).find(|&i| class_name(i) == name)
}

/// Number of combos in a class: 6 for pairs, 4 suited, 12 offsuit.
pub fn class_size(idx: usize) -> usize {
    let (i, j) = (idx / 13, idx % 13);
    if i == j {
        6
    } else if i < j {
        4
    } else {
        12
    }
}

pub struct Combos {
    /// combo id -> (card a, card b) with a < b
    pub cards: Vec<(u8, u8)>,
    /// 52 * a + b -> combo id (both orders filled), u16::MAX on the diagonal
    pub index: Vec<u16>,
    /// combo id -> class grid index
    pub class_of: Vec<u8>,
    /// combo id -> 52-bit card mask (bit = card id)
    pub mask: Vec<u64>,
    /// combo id -> evaluator bits (suit-major layout)
    pub ebits: Vec<u64>,
    /// class -> its combo ids
    #[allow(dead_code)] // read by tests
    pub class_combos: Vec<Vec<u16>>,
    /// card -> the 51 combos containing it
    pub with_card: Vec<Vec<u16>>,
}

pub fn combos() -> &'static Combos {
    static C: OnceLock<Combos> = OnceLock::new();
    C.get_or_init(|| {
        let mut cards = Vec::with_capacity(NUM_COMBOS);
        let mut index = vec![u16::MAX; 52 * 52];
        let mut class_of = Vec::with_capacity(NUM_COMBOS);
        let mut mask = Vec::with_capacity(NUM_COMBOS);
        let mut ebits = Vec::with_capacity(NUM_COMBOS);
        let mut class_combos = vec![Vec::new(); NUM_CLASSES];
        let mut with_card = vec![Vec::new(); 52];
        for a in 0..52u8 {
            for b in (a + 1)..52u8 {
                let id = cards.len() as u16;
                cards.push((a, b));
                index[52 * a as usize + b as usize] = id;
                index[52 * b as usize + a as usize] = id;
                let cl = class_of_cards(a, b);
                class_of.push(cl as u8);
                mask.push((1u64 << a) | (1u64 << b));
                ebits.push(eval_bit(a) | eval_bit(b));
                class_combos[cl].push(id);
                with_card[a as usize].push(id);
                with_card[b as usize].push(id);
            }
        }
        Combos { cards, index, class_of, mask, ebits, class_combos, with_card }
    })
}

#[inline]
pub fn combo_id(a: u8, b: u8) -> usize {
    combos().index[52 * a as usize + b as usize] as usize
}

/// xoshiro256** seeded through splitmix64. Deterministic for a given seed.
#[derive(Clone)]
pub struct Rng {
    s: [u64; 4],
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut z = seed;
        let mut next = || {
            z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            x ^ (x >> 31)
        };
        Rng { s: [next(), next(), next(), next()] }
    }

    /// An independent stream for (seed, stream) pairs.
    pub fn stream(seed: u64, stream: u64) -> Self {
        Rng::new(seed ^ stream.wrapping_mul(0xD1B5_4A32_D192_ED03).rotate_left(17))
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform integer in 0..n (Lemire's unbiased method).
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        let mut m = (self.next_u64() >> 32) * n as u64;
        if (m as u32) < n {
            let t = n.wrapping_neg() % n;
            while (m as u32) < t {
                m = (self.next_u64() >> 32) * n as u64;
            }
        }
        (m >> 32) as u32
    }
}

/// Draw `k` distinct cards from `deck[..len]` by a partial Fisher-Yates shuffle;
/// the drawn cards end up in deck[len-k..len].
#[inline]
pub fn draw(deck: &mut [u8], len: usize, k: usize, rng: &mut Rng) {
    for t in 0..k {
        let last = len - 1 - t;
        let j = rng.below((last + 1) as u32) as usize;
        deck.swap(j, last);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn class_names_match_project_grid() {
        assert_eq!(class_name(0), "AA");
        assert_eq!(class_name(1), "AKs");
        assert_eq!(class_name(13), "AKo");
        assert_eq!(class_name(168), "22");
        assert_eq!(class_name(12), "A2s");
        assert_eq!(class_name(13 * 12), "A2o");
        assert_eq!(class_name(13 * 12 + 11), "32o");
        assert_eq!(class_name(13 * 11 + 12), "32s");
        for i in 0..NUM_CLASSES {
            assert_eq!(class_index(&class_name(i)), Some(i));
        }
    }

    #[test]
    fn combos_partition_into_classes() {
        let c = combos();
        assert_eq!(c.cards.len(), NUM_COMBOS);
        let mut total = 0;
        for cl in 0..NUM_CLASSES {
            assert_eq!(c.class_combos[cl].len(), class_size(cl), "{}", class_name(cl));
            total += c.class_combos[cl].len();
        }
        assert_eq!(total, NUM_COMBOS);
        let (a, b) = parse_hand("AhKh").unwrap();
        assert_eq!(class_name(class_of_cards(a, b)), "AKs");
        let (a, b) = parse_hand("Kd7c").unwrap();
        assert_eq!(class_name(class_of_cards(a, b)), "K7o");
        let (a, b) = parse_hand("2c2d").unwrap();
        assert_eq!(class_name(class_of_cards(a, b)), "22");
        for card in 0..52 {
            assert_eq!(c.with_card[card].len(), 51);
        }
    }

    #[test]
    fn rng_is_uniform_enough_and_deterministic() {
        let mut r1 = Rng::new(7);
        let mut r2 = Rng::new(7);
        for _ in 0..100 {
            assert_eq!(r1.next_u64(), r2.next_u64());
        }
        let mut counts = [0u32; 52];
        let mut r = Rng::new(1);
        for _ in 0..520_000 {
            counts[r.below(52) as usize] += 1;
        }
        for &c in &counts {
            assert!((c as f64 - 10_000.0).abs() < 600.0, "{c}");
        }
    }
}
