//! Builds, solves and exports one puzzle (SPEC section 3).

use crate::eval::{eval7, hand_name};
use crate::grid::*;
use crate::model::*;
use postflop_solver::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Instant;

pub struct Ctx<'a> {
    pub ranges: &'a RangesFile,
    pub charts: &'a BTreeMap<String, ChartGrid>,
    /// Charts that failed validation, with the reason.
    pub bad_charts: &'a BTreeMap<String, String>,
}

pub struct Opts {
    pub target_pct: f64,
    pub max_iter: u32,
    /// Uncompressed estimate above this many bytes -> 16-bit compression.
    pub compress_above: u64,
    /// Compressed estimate above this many bytes -> refuse the puzzle.
    pub refuse_above: u64,
    /// Build the game and report memory only; no allocation, no solve.
    pub estimate_only: bool,
}

/// Result of `estimate`: memory estimates in bytes and the mode `solve` would use.
pub struct Estimate {
    pub mem_u: u64,
    pub mem_c: u64,
    pub mode: &'static str,
}

pub enum Run {
    Estimate(Estimate),
    Solved(Outcome),
}

pub struct Outcome {
    pub json: Value,
    pub mem_mb: f64,
    pub compressed: bool,
    pub iterations: u32,
    pub expl_pct: f64,
    pub seconds: f64,
}


/// Prints one progress line to stdout and flushes it, so a log file shows progress live.
pub fn progress(line: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

pub fn r2(x: f64) -> f64 {
    let v = (x * 100.0).round() / 100.0;
    if v == 0.0 { 0.0 } else { v }
}
pub fn r3(x: f64) -> f64 {
    let v = (x * 1000.0).round() / 1000.0;
    if v == 0.0 { 0.0 } else { v }
}

/// Money state from the hero's perspective, in chips.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct St {
    pub pot: i64,
    pub hs: i64,
    pub vs: i64,
    pub hb: i64,
    pub vb: i64,
}

impl St {
    pub fn json(&self, cpb: f64) -> Value {
        json!({
            "pot": r2(self.pot as f64 / cpb),
            "heroStack": r2(self.hs as f64 / cpb),
            "villainStack": r2(self.vs as f64 / cpb),
            "heroBet": r2(self.hb as f64 / cpb),
            "villainBet": r2(self.vb as f64 / cpb),
        })
    }
    /// Put the given seat's street total to `to` chips.
    fn put_to(&mut self, hero: bool, to: i64) {
        let (b, s) = if hero { (&mut self.hb, &mut self.hs) } else { (&mut self.vb, &mut self.vs) };
        let delta = to - *b;
        *b = to;
        *s -= delta;
        self.pot += delta;
    }
    fn new_street(&mut self) {
        self.hb = 0;
        self.vb = 0;
    }
}

fn bb_str(chips: i64, cpb: f64) -> String {
    let v = r2(chips as f64 / cpb);
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn chips(bb: f64, cpb: f64) -> i64 {
    (bb * cpb).round() as i64
}

// ---------------------------------------------------------------- preflop

/// One preflop entry replayed: state before / after (hero view), the amount
/// the acting seat had to call before acting.
#[derive(Debug, Clone)]
pub struct PreStep {
    pub before: St,
    pub after: St,
    pub to_call: i64,
}

/// Replays the scenario's preflop list with the blinds posted. Amounts are
/// raise-to / call-to totals for the acting seat.
pub fn simulate_preflop(scen: &Scenario, cpb: f64, hero_seat: &str, villain_seat: &str) -> Result<(Vec<PreStep>, St), String> {
    let seats = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
    let idx = |s: &str| seats.iter().position(|x| *x == s).ok_or_else(|| format!("unknown seat {s}"));
    let start = chips(100.0, cpb);
    let mut contrib = [0i64; 6];
    contrib[4] = chips(0.5, cpb);
    contrib[5] = chips(1.0, cpb);
    let (h, v) = (idx(hero_seat)?, idx(villain_seat)?);
    let view = |c: &[i64; 6]| St {
        pot: c.iter().sum(),
        hs: start - c[h],
        vs: start - c[v],
        hb: c[h],
        vb: c[v],
    };
    let mut out = Vec::new();
    for e in &scen.preflop {
        let s = idx(&e.seat)?;
        let before = view(&contrib);
        let max = *contrib.iter().max().unwrap();
        let to_call = max - contrib[s];
        match e.kind.as_str() {
            "fold" => {
                if s == h || s == v {
                    return Err(format!("preflop: {} folds but is in the hand", e.seat));
                }
            }
            "check" => {
                if to_call != 0 {
                    return Err(format!("preflop: {} checks facing a bet", e.seat));
                }
            }
            "call" | "raise" => {
                let a = chips(e.amount.ok_or_else(|| format!("preflop: {} {} without amount", e.seat, e.kind))?, cpb);
                if e.kind == "call" && a != max {
                    return Err(format!("preflop: {} calls to {} but the bet is {}", e.seat, bb_str(a, cpb), bb_str(max, cpb)));
                }
                if e.kind == "raise" && a <= max {
                    return Err(format!("preflop: {} raises to {} which is not above {}", e.seat, bb_str(a, cpb), bb_str(max, cpb)));
                }
                if a > start {
                    return Err(format!("preflop: {} puts in more than 100bb", e.seat));
                }
                contrib[s] = a;
            }
            k => return Err(format!("preflop: unknown kind '{k}'")),
        }
        out.push(PreStep { before, after: view(&contrib), to_call });
    }
    let mut fin = view(&contrib);
    fin.new_street();
    Ok((out, fin))
}

// ---------------------------------------------------------------- actions

fn kind_of(a: &Action) -> &'static str {
    match a {
        Action::Fold => "fold",
        Action::Check => "check",
        Action::Call => "call",
        Action::Bet(_) => "bet",
        Action::Raise(_) => "raise",
        Action::AllIn(_) => "allin",
        _ => "other",
    }
}

fn id_of(a: &Action) -> String {
    match a {
        Action::Bet(x) => format!("bet_{x}"),
        Action::Raise(x) => format!("raise_{x}"),
        k => kind_of(k).to_string(),
    }
}

/// Option object for action `a` taken by hero (`hero == true`) or villain from state `st`.
fn option_json(a: &Action, st: &St, hero: bool, cpb: f64) -> Value {
    let (my, opp) = if hero { (st.hb, st.vb) } else { (st.vb, st.hb) };
    let id = id_of(a);
    match a {
        Action::Fold => json!({"id": id, "kind": "fold", "label": "Fold"}),
        Action::Check => json!({"id": id, "kind": "check", "label": "Check"}),
        Action::Call => {
            let c = opp - my;
            json!({"id": id, "kind": "call", "amount": r2(c as f64 / cpb), "label": format!("Call {}", bb_str(c, cpb))})
        }
        Action::Bet(x) => {
            let pct = (100.0 * *x as f64 / st.pot as f64).round() as i64;
            json!({"id": id, "kind": "bet", "amount": r2(*x as f64 / cpb), "pctPot": pct,
                   "label": format!("Bet {} ({}%)", bb_str(*x as i64, cpb), pct)})
        }
        Action::Raise(x) => json!({"id": id, "kind": "raise", "amount": r2(*x as f64 / cpb),
                                    "label": format!("Raise to {}", bb_str(*x as i64, cpb))}),
        Action::AllIn(x) => {
            let mut v = json!({"id": id, "kind": "allin", "amount": r2(*x as f64 / cpb),
                               "label": format!("All-in {}", bb_str(*x as i64, cpb))});
            if opp == 0 {
                v["pctPot"] = json!((100.0 * *x as f64 / st.pot as f64).round() as i64);
            }
            v
        }
        _ => json!({"id": id, "kind": "other", "label": "?"}),
    }
}

fn apply(a: &Action, st: &mut St, hero: bool) {
    match a {
        Action::Call => {
            let to = if hero { st.vb } else { st.hb };
            st.put_to(hero, to);
        }
        Action::Bet(x) | Action::Raise(x) | Action::AllIn(x) => st.put_to(hero, *x as i64),
        _ => {}
    }
}

/// Picks the main-line action. `freqs` is the range frequency (villain) or the
/// hand frequency (hero) of each action.
fn choose(token: &str, actions: &[Action], freqs: &[f64], hero: bool) -> (usize, Option<String>) {
    let argmax = |pred: &dyn Fn(&Action) -> bool| -> Option<usize> {
        let mut best: Option<usize> = None;
        for (i, a) in actions.iter().enumerate() {
            if pred(a) && best.map_or(true, |b| freqs[i] > freqs[b]) {
                best = Some(i);
            }
        }
        best
    };
    let auto = || {
        if hero {
            argmax(&|_| true).unwrap()
        } else {
            argmax(&|a| *a != Action::Fold).unwrap_or(0)
        }
    };
    let bets: Vec<(usize, i32)> = actions.iter().enumerate().filter_map(|(i, a)| if let Action::Bet(x) = a { Some((i, *x)) } else { None }).collect();
    let found: Option<usize> = match token {
        "auto" => return (auto(), None),
        "check" => actions.iter().position(|a| *a == Action::Check),
        "call" => actions.iter().position(|a| *a == Action::Call),
        "fold" => actions.iter().position(|a| *a == Action::Fold),
        "allin" => actions.iter().position(|a| matches!(a, Action::AllIn(_))),
        "raise" => argmax(&|a| matches!(a, Action::Raise(_))),
        "bet" => argmax(&|a| matches!(a, Action::Bet(_))),
        "bet_small" => bets.iter().min_by_key(|b| b.1).map(|b| b.0),
        "bet_big" => bets.iter().max_by_key(|b| b.1).map(|b| b.0),
        other => {
            let i = auto();
            return (i, Some(format!("unknown token '{other}', used auto ({})", id_of(&actions[i]))));
        }
    };
    let who = if hero { "heroLine" } else { "villain" };
    match found {
        None => {
            let i = auto();
            (i, Some(format!("{who} token '{token}' is not available here, used auto ({})", id_of(&actions[i]))))
        }
        Some(i) if !hero && freqs[i] < 0.10 => {
            let j = auto();
            (j, Some(format!("villain token '{token}' ({}) has range frequency {:.3} < 0.10, fell back to auto ({})", id_of(&actions[i]), freqs[i], id_of(&actions[j]))))
        }
        Some(i) if hero && freqs[i] < 0.15 => (i, Some(format!("heroLine token '{token}' ({}) has hand frequency {:.3} < 0.15, kept", id_of(&actions[i]), freqs[i]))),
        Some(i) => (i, None),
    }
}

// ---------------------------------------------------------------- grids

struct GridOut {
    w: Vec<f64>,
    f: Vec<Vec<f64>>,
    freq: Vec<f64>,
    combos: f64,
}

/// Range grid from per-combo reach weights and (optionally) the strategy
/// (`strategy[k * n + h]`, `nact` actions).
fn combo_grid(cards: &[(Card, Card)], weights: &[f32], strategy: Option<(&[f32], usize)>) -> GridOut {
    let n = cards.len();
    let nact = strategy.map_or(0, |s| s.1);
    let mut wsum = vec![0.0f64; 169];
    let mut fsum = vec![vec![0.0f64; nact]; 169];
    let mut tot = vec![0.0f64; nact];
    let mut combos = 0.0;
    for (h, &(c1, c2)) in cards.iter().enumerate() {
        let w = weights[h] as f64;
        if !(w > 0.0) {
            continue;
        }
        let c = class_index(c1, c2);
        wsum[c] += w;
        combos += w;
        if let Some((s, _)) = strategy {
            for k in 0..nact {
                let p = s[k * n + h] as f64;
                fsum[c][k] += w * p;
                tot[k] += w * p;
            }
        }
    }
    let w = (0..169).map(|c| r3(wsum[c] / class_combos(c))).collect();
    let f = (0..169)
        .map(|c| (0..nact).map(|k| if wsum[c] > 0.0 { r3(fsum[c][k] / wsum[c]) } else { 0.0 }).collect())
        .collect();
    let freq = (0..nact).map(|k| if combos > 0.0 { r3(tot[k] / combos) } else { 0.0 }).collect();
    GridOut { w, f, freq, combos }
}

fn raw_freqs(cards_n: usize, weights: &[f32], strategy: &[f32], nact: usize) -> Vec<f64> {
    let mut tot = vec![0.0f64; nact];
    let mut sum = 0.0;
    for h in 0..cards_n {
        let w = weights[h] as f64;
        if !(w > 0.0) {
            continue;
        }
        sum += w;
        for k in 0..nact {
            tot[k] += w * strategy[k * cards_n + h] as f64;
        }
    }
    tot.iter().map(|t| if sum > 0.0 { t / sum } else { 0.0 }).collect()
}

fn weighted_avg(v: &[f32], w: &[f32]) -> f64 {
    let (mut a, mut b) = (0.0f64, 0.0f64);
    for (x, y) in v.iter().zip(w) {
        if *y > 0.0 {
            a += *x as f64 * *y as f64;
            b += *y as f64;
        }
    }
    if b > 0.0 { a / b } else { 0.0 }
}

// ---------------------------------------------------------------- rng

fn seed_from(id: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in id.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

// ---------------------------------------------------------------- main

pub fn run_puzzle(ctx: &Ctx, pz: &Puzzle, opts: &Opts) -> Result<Run, String> {
    let rf = ctx.ranges;
    let cpb = rf.chips_per_bb;
    let mut warnings: Vec<String> = Vec::new();

    let scen = rf.scenarios.get(&pz.scenario).ok_or_else(|| format!("unknown scenario '{}'", pz.scenario))?;
    let tree = rf.trees.get(&scen.tree).ok_or_else(|| format!("unknown tree '{}'", scen.tree))?;
    let hero_player: usize = match pz.hero.as_str() {
        "oop" => 0,
        "ip" => 1,
        h => return Err(format!("hero must be 'ip' or 'oop', got '{h}'")),
    };
    let vil_player = hero_player ^ 1;
    let sr = [&scen.oop, &scen.ip];
    let hero_seat = sr[hero_player].seat.clone();
    let vil_seat = sr[vil_player].seat.clone();

    // ---- cards
    let hand = parse_cards(&pz.hand, 2)?;
    let flop = parse_cards(&pz.flop, 3)?;
    let turn = parse_card(pz.turn.trim())?;
    let river = parse_card(pz.river.trim())?;
    let mut all = vec![hand[0], hand[1], flop[0], flop[1], flop[2], turn, river];
    all.sort_unstable();
    if all.windows(2).any(|w| w[0] == w[1]) {
        return Err("hero hand and board share a card (cards must be unique)".into());
    }
    let hero_hand = (hand[0].min(hand[1]), hand[0].max(hand[1]));
    let hero_class = class_index(hand[0], hand[1]);

    // ---- ranges
    // A player's postflop range is the product of that seat's own chart actions in the
    // preflop sequence: a "facing a 3-bet" chart holds frequencies given that the hand opened.
    let mut ranges: Vec<Range> = Vec::new();
    for p in 0..2 {
        let chart_key = &sr[p].chart;
        if let Some(e) = ctx.bad_charts.get(chart_key) {
            return Err(format!("scenario uses invalid chart: {e}"));
        }
        let chart = rf.charts.get(chart_key).ok_or_else(|| format!("unknown chart '{chart_key}'"))?;
        if !chart.ranges.contains_key(&sr[p].action) {
            return Err(format!("chart {chart_key} has no range for '{}'", sr[p].action));
        }
        let mut w = [1.0f64; 169];
        let mut chained = 0;
        for e in scen.preflop.iter().filter(|e| e.seat == sr[p].seat && e.chart.is_some()) {
            let ck = e.chart.as_ref().unwrap();
            if let Some(err) = ctx.bad_charts.get(ck) {
                return Err(format!("preflop chart invalid: {err}"));
            }
            let ch = rf.charts.get(ck).ok_or_else(|| format!("unknown chart '{ck}'"))?;
            let cg = &ctx.charts[ck];
            let k = ch
                .options
                .iter()
                .position(|o| o.id == e.kind)
                .or_else(|| ch.options.iter().position(|o| o.kind == e.kind))
                .ok_or_else(|| format!("chart {ck} has no option for preflop action '{}'", e.kind))?;
            for c in 0..169 {
                w[c] *= cg.freq[k][c];
            }
            chained += 1;
        }
        if chained == 0 {
            return Err(format!("scenario lists no chart action for seat {}", sr[p].seat));
        }
        let s = (0..169)
            .filter(|c| w[*c] >= 0.0005)
            .map(|c| format!("{}:{:.4}", class_name(c), w[c]))
            .collect::<Vec<_>>()
            .join(",");
        ranges.push(parse_range(&s)?);
    }
    let hw = ranges[hero_player].get_weight_by_cards(hero_hand.0, hero_hand.1);
    if !(hw > 0.0) {
        return Err(format!(
            "hero hand {} has zero weight in the hero's range ({}.{})",
            pz.hand, sr[hero_player].chart, sr[hero_player].action
        ));
    }

    // ---- preflop
    let mut steps: Vec<Value> = Vec::new();
    let mut dec_index = 0usize;
    let (pre, flop_state) = simulate_preflop(scen, cpb, &hero_seat, &vil_seat)?;
    let mut hero_prior_w = [1.0f64; 169];
    for (e, ps) in scen.preflop.iter().zip(pre.iter()) {
        let is_hero_dec = e.seat == hero_seat && e.chart.is_some();
        if is_hero_dec {
            let ck = e.chart.as_ref().unwrap();
            if let Some(err) = ctx.bad_charts.get(ck) {
                return Err(format!("preflop chart invalid: {err}"));
            }
            let chart = rf.charts.get(ck).ok_or_else(|| format!("unknown chart '{ck}'"))?;
            let cg = &ctx.charts[ck];
            let main = chart
                .options
                .iter()
                .position(|o| o.id == e.kind)
                .or_else(|| chart.options.iter().position(|o| o.kind == e.kind))
                .ok_or_else(|| format!("chart {ck} has no option for preflop action '{}'", e.kind))?;
            let opt = &chart.options[main];
            if let (Some(ca), Some(ea)) = (opt.amount, e.amount) {
                if opt.kind == "raise" && chips(ca, cpb) != chips(ea, cpb) {
                    warnings.push(format!("chart {ck} raise amount {ca} differs from scenario amount {ea}; scenario amount used for the state"));
                }
            }
            let nopt = chart.options.len();
            let options: Vec<Value> = chart
                .options
                .iter()
                .map(|o| {
                    let mut v = json!({"id": o.id, "kind": o.kind});
                    match o.kind.as_str() {
                        "call" => v["amount"] = json!(r2(ps.to_call as f64 / cpb)),
                        "raise" => v["amount"] = json!(r2(o.amount.unwrap_or(0.0))),
                        _ => {}
                    }
                    v["label"] = json!(o.label);
                    v
                })
                .collect();
            let hand_freq: Vec<f64> = (0..nopt).map(|k| r3(cg.freq[k][hero_class])).collect();
            if !(cg.freq[main][hero_class] > 0.0) {
                return Err(format!("hero hand {} ({}) never takes '{}' in chart {ck}", pz.hand, class_name(hero_class), e.kind));
            }
            // range grid: w = product of the hero's earlier chart actions
            let mut f = Vec::with_capacity(169);
            let mut tot = vec![0.0; nopt];
            let mut combos = 0.0;
            for c in 0..169 {
                let w = hero_prior_w[c];
                if w > 0.0 {
                    f.push((0..nopt).map(|k| r3(cg.freq[k][c])).collect::<Vec<_>>());
                    let cw = w * class_combos(c);
                    combos += cw;
                    for k in 0..nopt {
                        tot[k] += cw * cg.freq[k][c];
                    }
                } else {
                    f.push(vec![0.0; nopt]);
                }
            }
            let rfreq: Vec<f64> = tot.iter().map(|t| r3(t / combos)).collect();
            steps.push(json!({
                "type": "decision", "index": dec_index, "street": "preflop", "source": "chart",
                "chart": ck,
                "state": ps.before.json(cpb),
                "toCall": r2(ps.to_call as f64 / cpb),
                "options": options,
                "hand": {"freq": hand_freq, "ev": Value::Null, "equity": Value::Null},
                "mainLine": opt.id,
                "stateAfter": ps.after.json(cpb),
                "range": {"w": hero_prior_w.iter().map(|x| r3(*x)).collect::<Vec<_>>(), "f": f, "freq": rfreq,
                          "equity": Value::Null, "combos": r2(combos)},
                "villainRange": Value::Null,
            }));
            dec_index += 1;
            for c in 0..169 {
                hero_prior_w[c] *= cg.freq[main][c];
            }
        } else {
            let mut v = json!({"type": "action", "street": "preflop", "seat": e.seat, "kind": e.kind});
            if let Some(a) = e.amount {
                v["amount"] = json!(r2(a));
            }
            if ps.before != ps.after {
                v["state"] = ps.after.json(cpb);
            }
            steps.push(v);
        }
    }
    let pot_chips = chips(scen.pot_bb, cpb);
    let stack_chips = chips(scen.stack_bb, cpb);
    if flop_state.pot != pot_chips || flop_state.hs != stack_chips || flop_state.vs != stack_chips {
        return Err(format!(
            "preflop replay gives pot {} / stacks {} {} but the scenario says potBb {} / stackBb {}",
            bb_str(flop_state.pot, cpb), bb_str(flop_state.hs, cpb), bb_str(flop_state.vs, cpb), scen.pot_bb, scen.stack_bb
        ));
    }
    // consistency of the postflop range with the preflop chart chain
    if let Some(last) = scen.preflop.iter().filter(|e| e.seat == hero_seat && e.chart.is_some()).last() {
        if last.chart.as_deref() != Some(sr[hero_player].chart.as_str()) || last.kind != sr[hero_player].action {
            warnings.push(format!(
                "hero's postflop range {}.{} is not the hero's last preflop chart action {}.{}",
                sr[hero_player].chart, sr[hero_player].action, last.chart.as_deref().unwrap_or(""), last.kind
            ));
        }
    }

    // ---- build the game
    let st = |s: &str| s.to_string();
    let sizes = |s: &StreetSizes| -> Result<[BetSizeOptions; 2], String> {
        Ok([
            BetSizeOptions::try_from((s.oop_bet.as_str(), s.oop_raise.as_str())).map_err(|e| format!("tree {}: {e}", scen.tree))?,
            BetSizeOptions::try_from((s.ip_bet.as_str(), s.ip_raise.as_str())).map_err(|e| format!("tree {}: {e}", scen.tree))?,
        ])
    };
    let td = &rf.tree_defaults;
    let tree_config = TreeConfig {
        initial_state: BoardState::Flop,
        starting_pot: pot_chips as i32,
        effective_stack: stack_chips as i32,
        rake_rate: td.rake_rate,
        rake_cap: td.rake_cap,
        flop_bet_sizes: sizes(&tree.flop)?,
        turn_bet_sizes: sizes(&tree.turn)?,
        river_bet_sizes: sizes(&tree.river)?,
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: td.add_allin_threshold,
        force_allin_threshold: td.force_allin_threshold,
        merging_threshold: td.merging_threshold,
    };
    let mut action_tree = ActionTree::new(tree_config)?;
    if tree.flop.oop_bet.trim().is_empty() {
        // OOP may not lead the flop: remove every root action except check
        let root: Vec<Action> = action_tree.available_actions().to_vec();
        for a in root.into_iter().filter(|a| *a != Action::Check) {
            action_tree.remove_line(&[a])?;
            warnings.push(format!("removed OOP flop lead {} (leading disabled)", id_of(&a)));
        }
    }
    let card_config = CardConfig {
        range: [ranges[0], ranges[1]],
        flop: [flop[0], flop[1], flop[2]],
        turn: NOT_DEALT,
        river: NOT_DEALT,
    };
    let mut game = PostFlopGame::with_config(card_config, action_tree)?;
    let (mem_u, mem_c) = game.memory_usage();
    let compressed = mem_u > opts.compress_above;
    let refused = compressed && mem_c > opts.refuse_above;
    if opts.estimate_only {
        let mode = if refused { "REFUSED" } else if compressed { "16-bit" } else { "32-bit" };
        return Ok(Run::Estimate(Estimate { mem_u, mem_c, mode }));
    }
    progress(&format!(
        "  [{}] memory estimate: {:.0} MB uncompressed, {:.0} MB compressed -> {}",
        pz.id, mem_u as f64 / 1e6, mem_c as f64 / 1e6,
        if refused { "REFUSED" } else if compressed { "16-bit compression" } else { "32-bit float" }
    ));
    if refused {
        return Err(format!(
            "game too large: {:.0} MB even compressed (--refuse-above-mb {:.0})",
            mem_c as f64 / 1e6, opts.refuse_above as f64 / 1e6
        ));
    }
    let mem_mb = (if compressed { mem_c } else { mem_u }) as f64 / 1e6;
    game.allocate_memory(compressed);

    // ---- solve
    let t0 = Instant::now();
    let target = pot_chips as f32 * (opts.target_pct as f32) / 100.0;
    let mut expl = compute_exploitability(&game);
    let mut it: u32 = 0;
    while it < opts.max_iter && expl > target {
        solve_step(&game, it);
        it += 1;
        if it % 10 == 0 || it == opts.max_iter {
            expl = compute_exploitability(&game);
            progress(&format!("  [{}] iteration {it:4}  exploitability {:.3}% pot  {:.0} s", pz.id, 100.0 * expl as f64 / pot_chips as f64, t0.elapsed().as_secs_f64()));
        }
    }
    finalize(&mut game);
    let seconds = t0.elapsed().as_secs_f64();
    let expl_pct = 100.0 * expl as f64 / pot_chips as f64;

    // ---- walk the main line
    let hero_cards = game.private_cards(hero_player).to_vec();
    let vil_cards = game.private_cards(vil_player).to_vec();
    let hidx = hero_cards
        .iter()
        .position(|&c| c == hero_hand)
        .ok_or_else(|| format!("hero hand {} not among the hero's private hands", pz.hand))?;

    let mut s = flop_state;
    steps.push(json!({"type": "deal", "street": "flop", "cards": flop.iter().map(|&c| card_name(c)).collect::<Vec<_>>(), "state": s.json(cpb)}));
    let streets = ["flop", "turn", "river"];
    let mut street = 0usize;
    let mut hero_tokens = pz.hero_line.clone().unwrap_or_default().into_iter();
    let mut vil_tokens = pz.villain.clone().unwrap_or_default().into_iter();
    let mut last_fold_by: Option<usize> = None;
    let seat_of = |p: usize| if p == hero_player { hero_seat.clone() } else { vil_seat.clone() };

    loop {
        if game.is_terminal_node() {
            break;
        }
        if game.is_chance_node() {
            street += 1;
            let card = if street == 1 { turn } else { river };
            if game.possible_cards() & (1u64 << card) == 0 {
                return Err(format!("solver cannot deal {} on the {}", card_name(card), streets[street]));
            }
            game.play(card as usize);
            s.new_street();
            steps.push(json!({"type": "deal", "street": streets[street], "cards": [card_name(card)], "state": s.json(cpb)}));
            continue;
        }
        let p = game.current_player();
        let is_hero = p == hero_player;
        let actions = game.available_actions();
        let nact = actions.len();
        let options: Vec<Value> = actions.iter().map(|a| option_json(a, &s, is_hero, cpb)).collect();

        if nact == 1 {
            // forced action: an `action` step, no index, no token
            let a = actions[0];
            apply(&a, &mut s, is_hero);
            let mut v = json!({"type": "action", "street": streets[street], "seat": seat_of(p), "kind": kind_of(&a)});
            if let Some(am) = options[0].get("amount") {
                v["amount"] = am.clone();
            }
            v["state"] = s.json(cpb);
            steps.push(v);
            game.play(0);
            continue;
        }

        game.cache_normalized_weights();
        let strategy = game.strategy();
        if is_hero {
            let hw = game.weights(hero_player)[hidx];
            if !(hw > 0.0) {
                return Err("hero hand has zero reach at a hero decision (an earlier forced heroLine action had hand frequency 0)".into());
            }
            let n = hero_cards.len();
            let hand_freq: Vec<f64> = (0..nact).map(|k| strategy[k * n + hidx] as f64).collect();
            let evd = game.expected_values_detail(hero_player);
            let ev: Vec<f64> = (0..nact).map(|k| r2(evd[k * n + hidx] as f64 / cpb)).collect();
            let eq_h = game.equity(hero_player);
            let eq_v = game.equity(vil_player);
            let range_eq = weighted_avg(&eq_h, game.normalized_weights(hero_player));
            let vil_eq = weighted_avg(&eq_v, game.normalized_weights(vil_player));
            let g = combo_grid(&hero_cards, game.weights(hero_player), Some((&strategy, nact)));
            let vg = combo_grid(&vil_cards, game.weights(vil_player), None);

            let token = hero_tokens.next().unwrap_or_else(|| st("auto"));
            let (pick, warn) = choose(&token, &actions, &hand_freq, true);
            if let Some(w) = warn {
                warnings.push(format!("decision {dec_index} ({}): {w}", streets[street]));
            }
            if !(hand_freq[pick] > 0.0) {
                return Err(format!(
                    "decision {dec_index}: heroLine token '{token}' picks {} which the hand never plays (frequency 0); later EVs would be undefined",
                    id_of(&actions[pick])
                ));
            }
            let before = s;
            let to_call = s.vb - s.hb;
            apply(&actions[pick], &mut s, true);
            steps.push(json!({
                "type": "decision", "index": dec_index, "street": streets[street], "source": "solver",
                "state": before.json(cpb),
                "toCall": r2(to_call as f64 / cpb),
                "options": options,
                "hand": {"freq": hand_freq.iter().map(|x| r3(*x)).collect::<Vec<_>>(), "ev": ev, "equity": r3(eq_h[hidx] as f64)},
                "mainLine": id_of(&actions[pick]),
                "stateAfter": s.json(cpb),
                "range": {"w": g.w, "f": g.f, "freq": g.freq, "equity": r3(range_eq), "combos": r2(g.combos)},
                "villainRange": {"w": vg.w, "equity": r3(vil_eq), "combos": r2(vg.combos)},
            }));
            dec_index += 1;
            if actions[pick] == Action::Fold {
                last_fold_by = Some(p);
            }
            game.play(pick);
        } else {
            let n = vil_cards.len();
            let rfq = raw_freqs(n, game.weights(vil_player), &strategy, nact);
            let g = combo_grid(&vil_cards, game.weights(vil_player), Some((&strategy, nact)));
            let token = vil_tokens.next().unwrap_or_else(|| st("auto"));
            let (pick, warn) = choose(&token, &actions, &rfq, false);
            if let Some(w) = warn {
                warnings.push(format!("villain at {} ({}): {w}", streets[street], seat_of(p)));
            }
            apply(&actions[pick], &mut s, false);
            steps.push(json!({
                "type": "villain", "street": streets[street], "seat": vil_seat,
                "action": options[pick].clone(),
                "freq": r3(rfq[pick]),
                "options": options,
                "range": {"w": g.w, "f": g.f, "freq": g.freq, "combos": r2(g.combos)},
                "state": s.json(cpb),
            }));
            if actions[pick] == Action::Fold {
                last_fold_by = Some(p);
            }
            game.play(pick);
        }
        // cross-check the bookkeeping against the solver
        let tb = game.total_bet_amount();
        let (hp, vp) = (stack_chips - s.hs, stack_chips - s.vs);
        if tb[hero_player] as i64 != hp || tb[vil_player] as i64 != vp {
            return Err(format!("internal: state bookkeeping {hp}/{vp} disagrees with solver {tb:?}"));
        }
    }

    // ---- end
    let start = chips(100.0, cpb);
    let rest_tokens: Vec<String> = hero_tokens.collect();
    if !rest_tokens.is_empty() {
        warnings.push(format!("heroLine has {} unused token(s): {:?}", rest_tokens.len(), rest_tokens));
    }
    let rest_tokens: Vec<String> = vil_tokens.collect();
    if !rest_tokens.is_empty() {
        warnings.push(format!("villain has {} unused token(s): {:?}", rest_tokens.len(), rest_tokens));
    }
    let end = match last_fold_by {
        Some(p) if p == hero_player => {
            json!({"type": "end", "reason": "hero_fold", "state": s.json(cpb), "showdown": Value::Null,
                   "heroNet": r2((s.hs - start) as f64 / cpb)})
        }
        Some(_) => {
            json!({"type": "end", "reason": "villain_fold", "state": s.json(cpb), "showdown": Value::Null,
                   "heroNet": r2((s.hs + s.pot - start) as f64 / cpb)})
        }
        None => {
            // all-in before the river: run out the remaining puzzle cards
            while street < 2 {
                street += 1;
                let card = if street == 1 { turn } else { river };
                s.new_street();
                steps.push(json!({"type": "deal", "street": streets[street], "cards": [card_name(card)], "state": s.json(cpb)}));
            }
            let board = [flop[0], flop[1], flop[2], turn, river];
            let dead: u64 = board.iter().chain(hand.iter()).map(|&c| 1u64 << c).sum();
            let vw = game.weights(vil_player);
            let cand: Vec<(usize, f64)> = vil_cards
                .iter()
                .enumerate()
                .filter(|(i, &(a, b))| vw[*i] > 0.0 && dead & ((1u64 << a) | (1u64 << b)) == 0)
                .map(|(i, _)| (i, vw[i] as f64))
                .collect();
            let total: f64 = cand.iter().map(|c| c.1).sum();
            if cand.is_empty() || !(total > 0.0) {
                return Err("villain range is empty at showdown".into());
            }
            let mut seed = seed_from(&pz.id);
            let u = (splitmix(&mut seed) >> 11) as f64 / (1u64 << 53) as f64 * total;
            let mut acc = 0.0;
            let mut pick = cand.last().unwrap().0;
            for &(i, w) in &cand {
                acc += w;
                if u < acc {
                    pick = i;
                    break;
                }
            }
            let (va, vb) = vil_cards[pick];
            let hv = eval7(&[hand[0], hand[1], board[0], board[1], board[2], board[3], board[4]]);
            let vv = eval7(&[va, vb, board[0], board[1], board[2], board[3], board[4]]);
            let (winner, net) = if hv > vv {
                ("hero", (s.hs + s.pot - start) as f64)
            } else if vv > hv {
                ("villain", (s.hs - start) as f64)
            } else {
                ("split", s.hs as f64 + s.pot as f64 / 2.0 - start as f64)
            };
            json!({"type": "end", "reason": "showdown", "state": s.json(cpb),
                   "showdown": {"villainHand": [card_name(vb), card_name(va)], "winner": winner,
                                "heroHandName": hand_name(hv), "villainHandName": hand_name(vv)},
                   "heroNet": r2(net / cpb)})
        }
    };
    // free the solved game (several GB) before the next puzzle is built
    drop(game);
    steps.push(end);

    let json = json!({
        "version": 1,
        "id": pz.id,
        "title": pz.title,
        "tags": pz.tags,
        "scenario": {"key": pz.scenario, "name": scen.name, "potType": scen.pot_type, "tree": scen.tree},
        "hero": {"seat": hero_seat, "position": pz.hero, "hand": [card_name(hand[0]), card_name(hand[1])], "handClass": class_name(hero_class)},
        "villain": {"seat": vil_seat, "position": if hero_player == 0 { "ip" } else { "oop" }},
        "startingStackBb": 100,
        "board": {"flop": flop.iter().map(|&c| card_name(c)).collect::<Vec<_>>(), "turn": card_name(turn), "river": card_name(river)},
        "solver": {"exploitabilityPctPot": r2(expl_pct), "iterations": it, "memoryMb": mem_mb.round() as i64, "seconds": seconds.round() as i64,
                   "compressed": compressed, "targetPctPot": opts.target_pct},
        "warnings": warnings,
        "decisionCount": dec_index,
        "steps": steps,
    });
    Ok(Run::Solved(Outcome { json, mem_mb, compressed, iterations: it, expl_pct, seconds }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranges_file() -> RangesFile {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../data/ranges.json");
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn preflop_bookkeeping_matches_every_scenario() {
        let rf = ranges_file();
        for (key, scen) in &rf.scenarios {
            for (hs, vs) in [(&scen.ip.seat, &scen.oop.seat), (&scen.oop.seat, &scen.ip.seat)] {
                let (steps, fin) = simulate_preflop(scen, rf.chips_per_bb, hs, vs).unwrap();
                assert_eq!(fin.pot, chips(scen.pot_bb, 10.0), "{key} pot");
                assert_eq!(fin.hs, chips(scen.stack_bb, 10.0), "{key} hero stack");
                assert_eq!(fin.vs, chips(scen.stack_bb, 10.0), "{key} villain stack");
                // money is conserved: pot + both stacks = 200bb + dead money
                for s in &steps {
                    assert!(s.after.pot + s.after.hs + s.after.vs >= 2000);
                    assert_eq!(s.after.hs + s.after.hb, 1000);
                    assert_eq!(s.after.vs + s.after.vb, 1000);
                }
            }
        }
    }

    #[test]
    fn preflop_srp_states() {
        let rf = ranges_file();
        let scen = &rf.scenarios["BTN_BB_SRP"];
        let (steps, _) = simulate_preflop(scen, 10.0, "BB", "BTN").unwrap();
        // blinds posted: pot 1.5, BB has 1 in
        assert_eq!(steps[0].before, St { pot: 15, hs: 990, vs: 1000, hb: 10, vb: 0 });
        // BTN raise to 2.5
        assert_eq!(steps[3].after, St { pot: 40, hs: 990, vs: 975, hb: 10, vb: 25 });
        // BB faces 1.5 more and calls to 2.5
        assert_eq!(steps[5].to_call, 15);
        assert_eq!(steps[5].after, St { pot: 55, hs: 975, vs: 975, hb: 25, vb: 25 });
    }

    #[test]
    fn postflop_state_apply() {
        let mut s = St { pot: 55, hs: 975, vs: 975, hb: 0, vb: 0 };
        apply(&Action::Bet(18), &mut s, false);
        assert_eq!(s, St { pot: 73, hs: 975, vs: 957, hb: 0, vb: 18 });
        apply(&Action::Raise(54), &mut s, true);
        assert_eq!(s, St { pot: 127, hs: 921, vs: 957, hb: 54, vb: 18 });
        apply(&Action::Call, &mut s, false);
        assert_eq!(s, St { pot: 163, hs: 921, vs: 921, hb: 54, vb: 54 });
        let o = option_json(&Action::Call, &St { pot: 73, hs: 975, vs: 957, hb: 0, vb: 18 }, true, 10.0);
        assert_eq!(o["amount"], json!(1.8));
        assert_eq!(o["label"], json!("Call 1.8"));
        let b = option_json(&Action::Bet(18), &St { pot: 55, hs: 975, vs: 975, hb: 0, vb: 0 }, true, 10.0);
        assert_eq!(b["pctPot"], json!(33));
        assert_eq!(b["id"], json!("bet_18"));
    }

    #[test]
    fn tokens() {
        let acts = [Action::Check, Action::Bet(18), Action::Bet(41), Action::AllIn(975)];
        assert_eq!(choose("bet", &acts, &[0.2, 0.3, 0.45, 0.05], false).0, 2);
        assert_eq!(choose("bet_small", &acts, &[0.2, 0.3, 0.45, 0.05], false).0, 1);
        assert_eq!(choose("bet_big", &acts, &[0.2, 0.3, 0.45, 0.05], false).0, 2);
        // villain token below 0.10 falls back to auto with a warning
        let (i, w) = choose("allin", &acts, &[0.2, 0.3, 0.45, 0.05], false);
        assert_eq!(i, 2);
        assert!(w.is_some());
        // hero token below 0.15 is kept with a warning
        let (i, w) = choose("allin", &acts, &[0.2, 0.3, 0.45, 0.05], true);
        assert_eq!(i, 3);
        assert!(w.is_some());
        // villain auto skips fold
        let f = [Action::Fold, Action::Call, Action::Raise(54)];
        assert_eq!(choose("auto", &f, &[0.6, 0.3, 0.1], false).0, 1);
        assert_eq!(choose("auto", &f, &[0.6, 0.3, 0.1], true).0, 0);
    }
}
