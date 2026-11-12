//! 13x13 grid helpers, card parsing, and chart parsing / validation.
//!
//! Grid order (SPEC section 1): with R = "AKQJT98765432", entry 13*i + j is
//! the pair R[i]R[i] when i == j, the suited class R[i]R[j]s when i < j, and
//! the offsuit class R[j]R[i]o when i > j.
//!
//! Library card encoding: card = 4 * rank + suit, rank 2 => 0 .. A => 12,
//! suit c => 0, d => 1, h => 2, s => 3.

use crate::model::Chart;
use postflop_solver::{card_from_str, Range};

pub const RANKS: &str = "AKQJT98765432";

/// Library rank (0 = deuce .. 12 = ace) to grid row/column (0 = ace .. 12 = deuce).
#[inline]
pub fn rank_to_grid(rank: u8) -> usize {
    12 - rank as usize
}

/// Grid index of a two-card hand (library card ids, any order).
pub fn class_index(c1: u8, c2: u8) -> usize {
    let (r1, s1) = (c1 / 4, c1 % 4);
    let (r2, s2) = (c2 / 4, c2 % 4);
    let (hi, lo) = if r1 >= r2 { (r1, r2) } else { (r2, r1) };
    let (gh, gl) = (rank_to_grid(hi), rank_to_grid(lo));
    if hi == lo {
        13 * gh + gh
    } else if s1 == s2 {
        // suited: row = higher rank, column = lower rank (row < column)
        13 * gh + gl
    } else {
        // offsuit: row = lower rank, column = higher rank (row > column)
        13 * gl + gh
    }
}

/// Number of combos in a class (6 pairs, 4 suited, 12 offsuit).
pub fn class_combos(idx: usize) -> f64 {
    let (i, j) = (idx / 13, idx % 13);
    if i == j {
        6.0
    } else if i < j {
        4.0
    } else {
        12.0
    }
}

/// Human name of a class, e.g. "AKs", "AKo", "QQ".
pub fn class_name(idx: usize) -> String {
    let r: Vec<char> = RANKS.chars().collect();
    let (i, j) = (idx / 13, idx % 13);
    if i == j {
        format!("{}{}", r[i], r[i])
    } else if i < j {
        format!("{}{}s", r[i], r[j])
    } else {
        format!("{}{}o", r[j], r[i])
    }
}

/// Class-level weights (169) of a library range: the average weight over the
/// class's combos (no board removal).
pub fn range_to_grid(range: &Range) -> [f64; 169] {
    let mut g = [0.0; 169];
    for (idx, slot) in g.iter_mut().enumerate() {
        let (i, j) = (idx / 13, idx % 13);
        let (ri, rj) = ((12 - i) as u8, (12 - j) as u8);
        *slot = if i == j {
            range.get_weight_pair(ri)
        } else if i < j {
            range.get_weight_suited(ri, rj)
        } else {
            // offsuit class R[j]R[i]o: higher rank is column j
            range.get_weight_offsuit(rj, ri)
        } as f64;
    }
    g
}

pub fn parse_card(s: &str) -> Result<u8, String> {
    card_from_str(s).map_err(|e| format!("bad card '{s}': {e}"))
}

pub fn card_name(c: u8) -> String {
    let r = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    let s = ['c', 'd', 'h', 's'];
    format!("{}{}", r[(c / 4) as usize], s[(c % 4) as usize])
}

/// Parse a string of concatenated cards ("Kh7h3c") into card ids, in input order.
pub fn parse_cards(s: &str, n: usize) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.len() != 2 * n || !s.is_ascii() {
        return Err(format!("expected {n} cards in '{s}'"));
    }
    (0..n).map(|k| parse_card(&s[2 * k..2 * k + 2])).collect()
}

pub fn parse_range(s: &str) -> Result<Range, String> {
    s.parse::<Range>().map_err(|e| format!("range '{s}' rejected by postflop-solver: {e}"))
}

/// A chart resolved to per-class frequencies, one vector per option (in the
/// chart's option order). `fold` is the remainder.
#[derive(Debug, Clone)]
pub struct ChartGrid {
    #[allow(dead_code)]
    pub option_ids: Vec<String>,
    /// freq[option][class]
    pub freq: Vec<[f64; 169]>,
}


/// Parse and validate one chart. Returns the grid plus non-fatal notes
/// (overlapping tokens). Errors on unparsable strings, unknown option ids, a
/// missing fold option, or any class whose non-fold weights sum above 1.
pub fn build_chart(key: &str, chart: &Chart) -> Result<(ChartGrid, Vec<String>), String> {
    let mut notes = Vec::new();
    let option_ids: Vec<String> = chart.options.iter().map(|o| o.id.clone()).collect();
    let fold_idx = option_ids
        .iter()
        .position(|o| o == "fold")
        .ok_or_else(|| format!("chart {key}: no 'fold' option"))?;
    if chart.ranges.contains_key("fold") {
        return Err(format!("chart {key}: 'fold' must not have a range (it is the remainder)"));
    }
    for rid in chart.ranges.keys() {
        if !option_ids.contains(rid) {
            return Err(format!("chart {key}: range for unknown option '{rid}'"));
        }
    }
    let mut freq = vec![[0.0f64; 169]; option_ids.len()];
    for (k, id) in option_ids.iter().enumerate() {
        if k == fold_idx {
            continue;
        }
        let Some(s) = chart.ranges.get(id) else {
            notes.push(format!("chart {key}: option '{id}' has no range (treated as never)"));
            continue;
        };
        let range = parse_range(s).map_err(|e| format!("chart {key}.{id}: {e}"))?;
        freq[k] = range_to_grid(&range);
        // overlap check: parse every token separately
        let mut seen = [0u8; 169];
        for tok in s.split(',').map(str::trim).filter(|t| !t.is_empty()) {
            let r = parse_range(tok).map_err(|e| format!("chart {key}.{id}: {e}"))?;
            let g = range_to_grid(&r);
            for c in 0..169 {
                if g[c] > 0.0 {
                    seen[c] += 1;
                }
            }
        }
        for c in 0..169 {
            if seen[c] > 1 {
                notes.push(format!(
                    "chart {key}.{id}: class {} is listed more than once (the solver's parser keeps the first entry)",
                    class_name(c)
                ));
            }
        }
    }
    let mut bad = Vec::new();
    for c in 0..169 {
        let s: f64 = (0..option_ids.len()).filter(|&k| k != fold_idx).map(|k| freq[k][c]).sum();
        if s > 1.0 + 1e-6 {
            bad.push(format!("{} ({:.3})", class_name(c), s));
        }
        freq[fold_idx][c] = (1.0 - s).max(0.0);
    }
    if !bad.is_empty() {
        return Err(format!("chart {key}: non-fold weights sum above 1 for {}", bad.join(", ")));
    }
    Ok((ChartGrid { option_ids, freq }, notes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_index_mapping() {
        let c = |s: &str| parse_card(s).unwrap();
        // pairs on the diagonal
        assert_eq!(class_index(c("As"), c("Ah")), 0);
        assert_eq!(class_index(c("2s"), c("2h")), 168);
        // row A, column K is AKs; row K, column A is AKo
        assert_eq!(class_index(c("Ah"), c("Kh")), 1);
        assert_eq!(class_index(c("Kh"), c("Ah")), 1);
        assert_eq!(class_index(c("Ah"), c("Kd")), 13);
        assert_eq!(class_index(c("Kd"), c("Ah")), 13);
        // 98s: row 9 (5), column 8 (6) -> 71 ; 98o -> 13*6+5 = 83
        assert_eq!(class_index(c("9h"), c("8h")), 13 * 5 + 6);
        assert_eq!(class_index(c("9h"), c("8d")), 13 * 6 + 5);
        assert_eq!(class_name(1), "AKs");
        assert_eq!(class_name(13), "AKo");
        assert_eq!(class_name(13 * 5 + 6), "98s");
        assert_eq!(class_name(13 * 6 + 5), "98o");
        assert_eq!(class_name(12), "A2s");
        assert_eq!(class_name(13 * 12), "A2o");
        // every one of the 1326 combos lands in its class, with the right counts
        let mut counts = [0usize; 169];
        for a in 0..52u8 {
            for b in a + 1..52u8 {
                counts[class_index(a, b)] += 1;
            }
        }
        for i in 0..169 {
            assert_eq!(counts[i] as f64, class_combos(i), "class {}", class_name(i));
        }
    }

    #[test]
    fn range_grid_orientation() {
        let r = parse_range("AKs,QJo:0.5,77:0.25").unwrap();
        let g = range_to_grid(&r);
        assert_eq!(g[1], 1.0); // AKs
        assert_eq!(g[13], 0.0); // AKo
        // QJo: row J (3), column Q (2)
        assert_eq!(g[13 * 3 + 2], 0.5);
        assert_eq!(g[13 * 2 + 3], 0.0); // QJs
        assert_eq!(g[13 * 7 + 7], 0.25); // 77
        let total: f64 = g.iter().enumerate().map(|(i, w)| w * class_combos(i)).sum();
        assert!((total - (4.0 + 6.0 + 1.5)).abs() < 1e-9);
        // plus forms
        let g = range_to_grid(&parse_range("A2s+,ATo+,66+").unwrap());
        assert_eq!((1..13).filter(|&j| g[j] == 1.0).count(), 12);
        assert_eq!((1..13).filter(|&i| g[13 * i] == 1.0).count(), 4); // AKo..ATo
        assert_eq!((0..13).filter(|&i| g[14 * i] == 1.0).count(), 9); // AA..66
    }

    fn chart(ranges: &[(&str, &str)]) -> Chart {
        use crate::model::ChartOption;
        let mut opts = vec![ChartOption { id: "fold".into(), kind: "fold".into(), amount: None, label: "Fold".into() }];
        for (id, _) in ranges {
            opts.push(ChartOption { id: id.to_string(), kind: id.to_string(), amount: Some(2.5), label: id.to_string() });
        }
        Chart {
            title: String::new(),
            options: opts,
            ranges: ranges.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
        }
    }

    #[test]
    fn chart_validation() {
        let (g, notes) = build_chart("ok", &chart(&[("call", "99:0.5,88"), ("raise", "99:0.5,AA")])).unwrap();
        assert!(notes.is_empty());
        let nn = 13 * 5 + 5;
        assert_eq!(g.freq[0][nn], 0.0); // 99 fold
        assert_eq!(g.freq[1][nn], 0.5);
        assert_eq!(g.freq[2][nn], 0.5);
        assert_eq!(g.freq[0][168], 1.0); // 22 folds
        let err = build_chart("bad", &chart(&[("call", "99:0.75"), ("raise", "99:0.5")])).unwrap_err();
        assert!(err.contains("99"), "{err}");
        assert!(build_chart("bad", &chart(&[("call", "XYZ")])).is_err());
        let (_, notes) = build_chart("dup", &chart(&[("call", "A2s+,A5s:0.5")])).unwrap();
        assert!(notes.iter().any(|n| n.contains("A5s")));
    }
}
