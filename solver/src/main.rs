//! puzzle-solver: solves PokerPuzzles puzzles with postflop-solver and writes
//! data/solutions/<id>.json plus <id>.summary.txt (see docs/SPEC.md).

mod eval;
mod export;
mod grid;
mod model;
mod summary;

use export::{progress, Run};
use model::{Puzzle, RangesFile};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage:
  puzzle-solver solve --ranges data/ranges.json --puzzles data/puzzles.json --out data/solutions \\
      [--only p001,p003] [--skip-existing] [--target 0.3] [--max-iter 1000] \\
      [--compress-above-mb 3000] [--refuse-above-mb 6000]
  puzzle-solver estimate --ranges data/ranges.json --puzzles data/puzzles.json \\
      [--only p001,p003] [--compress-above-mb 3000] [--refuse-above-mb 6000]

  --compress-above-mb: use 16-bit compression when the uncompressed estimate is above this (MB = 10^6 bytes)
  --refuse-above-mb:   refuse a puzzle whose compressed estimate is above this";

#[derive(PartialEq)]
enum Cmd {
    Solve,
    Estimate,
}

struct Args {
    cmd: Cmd,
    ranges: PathBuf,
    puzzles: PathBuf,
    out: PathBuf,
    only: Option<Vec<String>>,
    skip_existing: bool,
    target: f64,
    max_iter: u32,
    compress_above_mb: f64,
    refuse_above_mb: f64,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    let cmd = match it.next().as_deref() {
        Some("solve") => Cmd::Solve,
        Some("estimate") => Cmd::Estimate,
        _ => return Err(USAGE.into()),
    };
    let mut a = Args {
        cmd,
        ranges: "data/ranges.json".into(),
        puzzles: "data/puzzles.json".into(),
        out: "data/solutions".into(),
        only: None,
        skip_existing: false,
        target: 0.3,
        max_iter: 1000,
        compress_above_mb: 3000.0,
        refuse_above_mb: 6000.0,
    };
    let solve_only = |k: &str, a: &Args| -> Result<(), String> {
        if a.cmd == Cmd::Estimate {
            Err(format!("{k} is not valid for estimate\n{USAGE}"))
        } else {
            Ok(())
        }
    };
    while let Some(k) = it.next() {
        let mut val = || it.next().ok_or_else(|| format!("{k} needs a value\n{USAGE}"));
        match k.as_str() {
            "--ranges" => a.ranges = val()?.into(),
            "--puzzles" => a.puzzles = val()?.into(),
            "--only" => a.only = Some(val()?.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()),
            "--compress-above-mb" => a.compress_above_mb = val()?.parse().map_err(|e| format!("--compress-above-mb: {e}"))?,
            "--refuse-above-mb" => a.refuse_above_mb = val()?.parse().map_err(|e| format!("--refuse-above-mb: {e}"))?,
            "--out" => {
                let v = val()?;
                solve_only(&k, &a)?;
                a.out = v.into()
            }
            "--skip-existing" => {
                solve_only(&k, &a)?;
                a.skip_existing = true
            }
            "--target" => {
                let v = val()?;
                solve_only(&k, &a)?;
                a.target = v.parse().map_err(|e| format!("--target: {e}"))?
            }
            "--max-iter" => {
                let v = val()?;
                solve_only(&k, &a)?;
                a.max_iter = v.parse().map_err(|e| format!("--max-iter: {e}"))?
            }
            "-h" | "--help" => return Err(USAGE.into()),
            _ => return Err(format!("unknown argument {k}\n{USAGE}")),
        }
    }
    if !(a.target > 0.0) {
        return Err("--target must be positive".into());
    }
    if !(a.compress_above_mb > 0.0) || !(a.refuse_above_mb > 0.0) {
        return Err("memory thresholds must be positive".into());
    }
    Ok(a)
}

fn read_json<T: serde::de::DeserializeOwned>(p: &PathBuf) -> Result<T, String> {
    let s = std::fs::read_to_string(p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
    serde_json::from_str(&s).map_err(|e| format!("cannot parse {}: {e}", p.display()))
}

fn panic_text(p: Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let rf: RangesFile = match read_json(&args.ranges) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let puzzles: Vec<Puzzle> = match read_json(&args.puzzles) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };

    // validate every chart once
    let mut charts = BTreeMap::new();
    let mut bad = BTreeMap::new();
    progress(&format!("Validating {} charts ...", rf.charts.len()));
    for (k, c) in &rf.charts {
        match grid::build_chart(k, c) {
            Ok((g, notes)) => {
                for n in notes {
                    progress(&format!("  note: {n}"));
                }
                charts.insert(k.clone(), g);
            }
            Err(e) => {
                progress(&format!("  INVALID: {e}"));
                bad.insert(k.clone(), e);
            }
        }
    }
    if bad.is_empty() {
        progress("  all charts parse and every class sums to at most 1");
    }

    let ctx = export::Ctx { ranges: &rf, charts: &charts, bad_charts: &bad };
    let opts = export::Opts {
        target_pct: args.target,
        max_iter: args.max_iter,
        compress_above: (args.compress_above_mb * 1e6) as u64,
        refuse_above: (args.refuse_above_mb * 1e6) as u64,
        estimate_only: args.cmd == Cmd::Estimate,
    };

    let selected: Vec<&Puzzle> = puzzles
        .iter()
        .filter(|p| args.only.as_ref().map_or(true, |o| o.contains(&p.id)))
        .collect();
    if let Some(o) = &args.only {
        for id in o {
            if !puzzles.iter().any(|p| &p.id == id) {
                eprintln!("warning: --only id {id} not found");
            }
        }
    }

    if args.cmd == Cmd::Estimate {
        return estimate(&ctx, &opts, &selected, &args);
    }

    if let Err(e) = std::fs::create_dir_all(&args.out) {
        eprintln!("cannot create {}: {e}", args.out.display());
        return ExitCode::from(2);
    }
    let mut failed = Vec::new();
    let mut done = 0;
    for pz in selected {
        let json_path = args.out.join(format!("{}.json", pz.id));
        let txt_path = args.out.join(format!("{}.summary.txt", pz.id));
        if args.skip_existing && json_path.exists() {
            progress(&format!("{}: exists, skipped", pz.id));
            continue;
        }
        progress(&format!("{}: {} ({}, hero {} {})", pz.id, pz.title, pz.scenario, pz.hero, pz.hand));
        // the game lives only inside run_puzzle and is dropped before it returns
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| export::run_puzzle(&ctx, pz, &opts)));
        let res = match res {
            Ok(r) => r,
            Err(p) => Err(format!("panic: {}", panic_text(p))),
        };
        match res {
            Ok(Run::Solved(out)) => {
                let text = serde_json::to_string_pretty(&out.json).unwrap();
                let summ = summary::summarize(&out.json);
                if let Err(e) = std::fs::write(&json_path, text + "\n").and_then(|_| std::fs::write(&txt_path, &summ)) {
                    progress(&format!("{}: FAILED writing output: {e}", pz.id));
                    failed.push(pz.id.clone());
                    continue;
                }
                progress(&format!(
                    "{}: ok  memory {:.0} MB{}  iterations {}  exploitability {:.3}% pot  {:.1} s  decisions {}  warnings {}",
                    pz.id, out.mem_mb, if out.compressed { " (compressed)" } else { "" }, out.iterations, out.expl_pct, out.seconds,
                    out.json["decisionCount"], out.json["warnings"].as_array().map_or(0, |w| w.len())
                ));
                done += 1;
            }
            Ok(Run::Estimate(_)) => unreachable!(),
            Err(e) => {
                progress(&format!("{}: FAILED: {e}", pz.id));
                failed.push(pz.id.clone());
            }
        }
    }
    progress(&format!(
        "Done: {done} solved, {} failed{}",
        failed.len(),
        if failed.is_empty() { String::new() } else { format!(" ({})", failed.join(", ")) }
    ));
    if failed.is_empty() { ExitCode::SUCCESS } else { ExitCode::from(1) }
}

/// Builds every selected puzzle's game (no allocation, no solve, nothing written)
/// and prints the memory table.
fn estimate(ctx: &export::Ctx, opts: &export::Opts, selected: &[&Puzzle], args: &Args) -> ExitCode {
    progress(&format!(
        "Thresholds: compress above {:.0} MB uncompressed, refuse above {:.0} MB compressed",
        args.compress_above_mb, args.refuse_above_mb
    ));
    progress(&format!("{:<6} {:<12} {:<8} {:>9} {:>9}  {}", "id", "scenario", "flop", "uncompMB", "compMB", "mode"));
    let (mut tu, mut tc, mut solve_mb) = (0.0f64, 0.0f64, 0.0f64);
    let mut modes: BTreeMap<&str, usize> = BTreeMap::new();
    let mut failed = Vec::new();
    for pz in selected {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| export::run_puzzle(ctx, pz, opts)));
        let res = match res {
            Ok(r) => r,
            Err(p) => Err(format!("panic: {}", panic_text(p))),
        };
        match res {
            Ok(Run::Estimate(e)) => {
                let (u, c) = (e.mem_u as f64 / 1e6, e.mem_c as f64 / 1e6);
                tu += u;
                tc += c;
                solve_mb += match e.mode {
                    "32-bit" => u,
                    "16-bit" => c,
                    _ => 0.0,
                };
                *modes.entry(e.mode).or_default() += 1;
                progress(&format!("{:<6} {:<12} {:<8} {:>9.0} {:>9.0}  {}", pz.id, pz.scenario, pz.flop, u, c, e.mode));
            }
            Ok(Run::Solved(_)) => unreachable!(),
            Err(e) => {
                progress(&format!("{:<6} {:<12} {:<8} ERROR: {e}", pz.id, pz.scenario, pz.flop));
                failed.push(pz.id.clone());
            }
        }
    }
    let modes: Vec<String> = modes.iter().map(|(m, n)| format!("{n} {m}")).collect();
    progress(&format!(
        "TOTAL  {} puzzles: {}{}; sum {:.0} MB uncompressed, {:.0} MB compressed, {:.0} MB as solve would allocate (one at a time)",
        selected.len(),
        modes.join(", "),
        if failed.is_empty() { String::new() } else { format!(", {} errors ({})", failed.len(), failed.join(", ")) },
        tu, tc, solve_mb
    ));
    if failed.is_empty() { ExitCode::SUCCESS } else { ExitCode::from(1) }
}
