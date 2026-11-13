//! Validation commands: exact all-in equities of specific hands (two
//! evaluators), and the heads-up stack sweep compared with published charts.

use crate::cards::{class_name, eval_bit, parse_hand, NUM_CLASSES};
use crate::eval::{eval7, naive7};
use crate::game::{AccuracySpec, AnteSpec, BlindSpec, PayoffSpec, Spec, Table};
use crate::hu;
use rayon::prelude::*;
use serde_json::json;
use std::path::Path;

/// Exact showdown statistics of k specific hands over every board:
/// per hand P(win alone), P(tie), equity (pot share).
pub fn exact_equity(hands: &[(u8, u8)], naive: bool) -> (Vec<f64>, Vec<f64>, Vec<f64>, u64) {
    let k = hands.len();
    let mut used = 0u64;
    for &(a, b) in hands {
        assert!(used & (1 << a) == 0 && used & (1 << b) == 0, "hands share a card");
        used |= (1u64 << a) | (1u64 << b);
    }
    let deck: Vec<u8> = (0..52u8).filter(|&c| used & (1u64 << c) == 0).collect();
    let m = deck.len();
    // parallel over the first board card
    let parts: Vec<(Vec<f64>, Vec<f64>, Vec<f64>, u64)> = (0..m)
        .into_par_iter()
        .map(|a| {
            let mut win = vec![0.0; k];
            let mut tie = vec![0.0; k];
            let mut eq = vec![0.0; k];
            let mut n = 0u64;
            let mut vals = vec![0u32; k];
            for b in a + 1..m {
                for c in b + 1..m {
                    for d in c + 1..m {
                        for e in d + 1..m {
                            let board = [deck[a], deck[b], deck[c], deck[d], deck[e]];
                            for (t, &(x, y)) in hands.iter().enumerate() {
                                vals[t] = if naive {
                                    naive7([board[0], board[1], board[2], board[3], board[4], x, y])
                                } else {
                                    let bits = board.iter().fold(0u64, |s, &cc| s | eval_bit(cc));
                                    eval7(bits | eval_bit(x) | eval_bit(y))
                                };
                            }
                            let best = *vals.iter().max().unwrap();
                            let nb = vals.iter().filter(|&&v| v == best).count();
                            for t in 0..k {
                                if vals[t] == best {
                                    if nb == 1 {
                                        win[t] += 1.0;
                                    } else {
                                        tie[t] += 1.0;
                                    }
                                    eq[t] += 1.0 / nb as f64;
                                }
                            }
                            n += 1;
                        }
                    }
                }
            }
            (win, tie, eq, n)
        })
        .collect();
    let mut win = vec![0.0; k];
    let mut tie = vec![0.0; k];
    let mut eq = vec![0.0; k];
    let mut n = 0u64;
    for (w, t, e, c) in parts {
        for i in 0..k {
            win[i] += w[i];
            tie[i] += t[i];
            eq[i] += e[i];
        }
        n += c;
    }
    let f = |v: Vec<f64>| v.iter().map(|x| x / n as f64).collect::<Vec<f64>>();
    (f(win), f(tie), f(eq), n)
}

pub fn equity_cmd(args: &[String]) -> Result<(), String> {
    let naive = args.iter().any(|a| a == "--naive");
    // skip option values (--threads N)
    let mut plain: Vec<&String> = Vec::new();
    let mut skip = false;
    for a in args {
        if skip {
            skip = false;
            continue;
        }
        if a == "--threads" {
            skip = true;
            continue;
        }
        if !a.starts_with("--") {
            plain.push(a);
        }
    }
    let hands: Vec<(u8, u8)> = plain
        .iter()
        .map(|a| parse_hand(a).ok_or(format!("bad hand {a}")))
        .collect::<Result<_, _>>()?;
    if hands.len() < 2 {
        return Err("give at least two hands".into());
    }
    let (win, tie, eq, n) = exact_equity(&hands, naive);
    let names: Vec<String> = plain.iter().map(|s| s.to_string()).collect();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "hands": names, "boards": n, "evaluator": if naive {"naive best-of-21"} else {"fast"},
            "win": win, "tie": tie, "equity": eq,
        }))
        .unwrap()
    );
    Ok(())
}

fn hu_spec(stack: f64, ante: f64) -> Spec {
    Spec {
        name: None,
        note: None,
        players: 2,
        stacks: vec![stack, stack],
        ante: if ante > 0.0 { AnteSpec::PerPlayer { amount: ante } } else { AnteSpec::None },
        blinds: BlindSpec::default(),
        payoff: PayoffSpec::Chips,
        accuracy: AccuracySpec::default(),
    }
}

/// Solve heads-up push/fold exactly on a grid of stacks; per class the
/// stack intervals where the hand jams (SB) / calls (BB) with frequency >= 0.5.
pub fn hu_sweep_cmd(args: &[String]) -> Result<(), String> {
    let get = |name: &str, d: f64| {
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).and_then(|s| s.parse().ok()).unwrap_or(d)
    };
    let from = get("--from", 1.0);
    let to = get("--to", 20.0);
    let step = get("--step", 0.05);
    let ante = get("--ante", 0.0);
    let out = args.iter().position(|a| a == "--out").and_then(|i| args.get(i + 1)).ok_or("--out required")?;
    let _ = hu::class_pairs();
    let nsteps = ((to - from) / step).round() as usize + 1;
    let stacks: Vec<f64> = (0..nsteps).map(|i| ((from + i as f64 * step) * 1e6).round() / 1e6).collect();
    let t0 = std::time::Instant::now();
    let res: Vec<(Vec<f64>, Vec<f64>, f64, usize)> = stacks
        .par_iter()
        .map(|&s| {
            let spec = hu_spec(s, ante);
            let table = Table::from_spec(&spec).unwrap();
            let sol = hu::solve_hu(&table, 1e-7, 200_000);
            let mx = sol.exploit_in_sample.iter().cloned().fold(0.0, f64::max);
            // a big blind all-in by posting has no decision: he is always in
            let bb = sol.decisions.iter().find(|d| d.info.player == 1).map(|d| d.freq.clone()).unwrap_or(vec![1.0; NUM_CLASSES]);
            let sb = sol.decisions.iter().find(|d| d.info.player == 0).map(|d| d.freq.clone()).unwrap_or(vec![1.0; NUM_CLASSES]);
            (sb, bb, mx, sol.iterations)
        })
        .collect();
    eprintln!("hu-sweep: {} stacks in {:.1}s", stacks.len(), t0.elapsed().as_secs_f64());
    let intervals = |which: usize| {
        let mut m = serde_json::Map::new();
        for h in 0..NUM_CLASSES {
            let mut iv: Vec<[f64; 2]> = Vec::new();
            let mut start: Option<f64> = None;
            for (k, &s) in stacks.iter().enumerate() {
                let f = if which == 0 { res[k].0[h] } else { res[k].1[h] };
                let on = f >= 0.5;
                match (on, start) {
                    (true, None) => start = Some(s),
                    (false, Some(a)) => {
                        iv.push([a, stacks[k - 1]]);
                        start = None
                    }
                    _ => {}
                }
            }
            if let Some(a) = start {
                iv.push([a, *stacks.last().unwrap()]);
            }
            m.insert(class_name(h), json!(iv));
        }
        serde_json::Value::Object(m)
    };
    let mixed = |which: usize| {
        // classes played with 0.05 < freq < 0.95 at some stack
        let mut v = Vec::new();
        for (k, &s) in stacks.iter().enumerate() {
            for h in 0..NUM_CLASSES {
                let f = if which == 0 { res[k].0[h] } else { res[k].1[h] };
                if f > 0.05 && f < 0.95 {
                    v.push(json!([s, class_name(h), (f * 1000.0).round() / 1000.0]));
                }
            }
        }
        v
    };
    let worst = res.iter().map(|r| r.2).fold(0.0, f64::max);
    let v = json!({
        "game": {"players": 2, "blinds": [0.5, 1.0], "ante_per_player": ante, "payoff": "chips", "stack": "both players, bb before posting"},
        "engine": "pushfold exact heads-up (exact equities, CFR+)",
        "stacks": stacks,
        "max_exploitability_bb_per_hand": worst,
        "iterations_max": res.iter().map(|r| r.3).max(),
        "sb_jam_intervals": intervals(0),
        "bb_call_intervals": intervals(1),
        "sb_mixed": mixed(0),
        "bb_mixed": mixed(1),
    });
    let p = Path::new(out);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, serde_json::to_string_pretty(&v).unwrap() + "\n").map_err(|e| e.to_string())?;
    Ok(())
}

/// Size of the card-removal effect of folded players' hands ("bunching" plus
/// dead cards for the board). For a solved spot with 3+ players, recompute the
/// SB's first-in jam and the BB's call against it (everybody else folded) in a
/// model that ignores the folded players' cards: exact heads-up equities from a
/// deck without them and the BB's hand uniform given the SB's. Compare with the
/// solution's EV differences, which include all card removal.
pub fn bunching_cmd(args: &[String]) -> Result<(), String> {
    let get = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let path = get("--solution").ok_or("--solution required")?;
    let out = get("--out").ok_or("--out required")?;
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let spec: Spec = serde_json::from_value(v["spec"].clone()).map_err(|e| e.to_string())?;
    let table = Table::from_spec(&spec)?;
    // heads-up (no folded players) is the control: the two models must agree
    let pay = crate::game::Payoffs::new(&table);
    let (sb, bb) = (table.sb, table.bb);
    let dec = |id: &str| v["decisions"].as_array().unwrap().iter().find(|d| d["id"] == id).cloned();
    let sbd = dec("SB_open").ok_or("SB_open missing")?;
    let bbd = dec("BB_vs_SB").ok_or("BB_vs_SB missing")?;
    let arr = |d: &serde_json::Value, k: &str| -> Vec<Option<f64>> { d[k].as_array().unwrap().iter().map(|x| x.as_f64()).collect() };
    let s_jam: Vec<f64> = arr(&sbd, "freq").iter().map(|x| x.unwrap()).collect();
    let b_call: Vec<f64> = arr(&bbd, "freq").iter().map(|x| x.unwrap()).collect();
    let val = |vmask: u32, ksb: u8, kbb: u8, p: usize| {
        let tm = &pay.terms[vmask as usize];
        let mut key = [0u8; crate::game::MAX_PLAYERS];
        key[sb] = ksb;
        key[bb] = kbb;
        pay.value(tm, pay.encode(tm, &key), p)
    };
    let steal_v = 1u32 << sb;
    let show_v = (1u32 << sb) | (1u32 << bb);
    let cp = hu::class_pairs();
    let mut out_rows = Vec::new();
    let mut summary = serde_json::Map::new();
    for (side, d) in [("SB_open", &sbd), ("BB_vs_SB", &bbd)] {
        let me = if side == "SB_open" { sb } else { bb };
        let true_diff = arr(d, "ev_diff");
        let se = arr(d, "ev_diff_se");
        let (mut wsum, mut wabs, mut maxabs, mut flips, mut sig) = (0.0, 0.0, 0.0f64, 0, 0);
        for h in 0..NUM_CLASSES {
            // independent model
            let (mut num_a, mut num_f, mut den) = (0.0, 0.0, 0.0);
            for o in 0..NUM_CLASSES {
                let (h1, h2) = if me == sb { (h, o) } else { (o, h) };
                let k = hu::ClassPairs::idx(h1, h2);
                let nn = cp.pairs[k] as f64;
                if nn == 0.0 {
                    continue;
                }
                let (pw, pt) = cp.probs(h1, h2); // SB's win / tie
                let pl = 1.0 - pw - pt;
                let showdown = pw * val(show_v, 0, 1, me) + pt * val(show_v, 0, 0, me) + pl * val(show_v, 1, 0, me);
                if me == sb {
                    let c = b_call[h2];
                    num_a += nn * ((1.0 - c) * val(steal_v, 0, 0, sb) + c * showdown);
                    num_f += nn * val(0, 0, 0, sb);
                    den += nn;
                } else {
                    let w = s_jam[h1] * nn;
                    num_a += w * showdown;
                    num_f += w * val(steal_v, 0, 0, bb);
                    den += w;
                }
            }
            let indep = (num_a - num_f) / den;
            if let (Some(t), Some(s)) = (true_diff[h], se[h]) {
                let delta = t - indep;
                let w = crate::cards::class_size(h) as f64;
                wsum += w;
                wabs += w * delta.abs();
                maxabs = maxabs.max(delta.abs());
                if delta.abs() > 3.0 * s {
                    sig += 1;
                }
                if t.signum() != indep.signum() && t.abs() > 2.0 * s {
                    flips += 1;
                }
                out_rows.push(json!({"decision": side, "class": class_name(h), "ev_diff_full_deal": t, "se": s, "ev_diff_folded_cards_ignored": indep, "delta": delta}));
            }
        }
        summary.insert(
            side.into(),
            json!({"mean_abs_delta_combo_weighted": wabs / wsum, "max_abs_delta": maxabs,
                   "classes_delta_beyond_3_se": sig, "classes_where_the_better_action_changes": flips}),
        );
    }
    let report = json!({
        "solution": Path::new(&path).file_name().unwrap().to_string_lossy(),
        "what": "EV difference (all-in minus fold) of the SB's first-in jam and the BB's call of it after everybody else folded: full-deal solution (all card removal) versus a model that ignores the folded players' cards (exact heads-up equities, BB hand uniform given the SB's), both against the same strategies",
        "units": table.payoff_units(),
        "summary": summary,
        "rows": out_rows,
    });
    std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap() + "\n").map_err(|e| e.to_string())?;
    eprintln!("{}", serde_json::to_string_pretty(&report["summary"]).unwrap());
    Ok(())
}
