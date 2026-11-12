You are helping with a batch of poker solver calculations. Another Claude session on a different computer is running the same job and has given you half of the remaining work. Your results will be merged into its results automatically, so they must come from exactly the same solver, the same inputs and the same settings. Please do not change any of them.

## What this is

A group of friends runs a poker puzzle site: fixed Texas hold'em hands, graded against a game-theory solver. Each hand has to be solved once, heads-up from the flop onward, with a small Rust program (`puzzle-solver`, a thin wrapper around the open-source `postflop-solver` library). One solve takes 3 to 8 minutes on an 8-core laptop and uses up to about 3.5 GB of RAM. Your share is 27 hands, so expect two to three hours of computing. Nothing here needs poker knowledge: you build one program, run one command, check the output and pack it.

## What you have

The folder `pokerpuzzles-solve-B` (from `pokerpuzzles-solve-B.zip`), containing:

- `solver/` — the Rust source of `puzzle-solver` (`Cargo.toml`, `Cargo.lock`, `src/`)
- `data/ranges.json` — preflop ranges and bet-size trees (input)
- `data/puzzles.json` — the hand definitions (input)
- `ids-B.txt` — one line: the 27 hand ids you solve, comma-separated
- `SHA256SUMS` — checksums of all of the above

If you do not have the folder, ask the person you are working with for `pokerpuzzles-solve-B.zip` before doing anything else.

## What the computer needs

- macOS or Linux with a real shell, at least 16 GB of RAM, ideally 6 or more CPU cores.
- A Rust toolchain (`cargo`, any recent stable version). If it is missing, ask the person before installing it (the usual way is rustup from https://rustup.rs).
- Internet access for the first build: Cargo downloads `postflop-solver` from GitHub at the commit pinned in `Cargo.lock`.

If the machine has less than 16 GB of RAM or no way to run Rust, stop and say so rather than trying a workaround.

## Steps

1. Go into the folder and verify the inputs: `shasum -a 256 -c SHA256SUMS` (on Linux: `sha256sum -c SHA256SUMS`). Every line must say OK. If not, stop and report.
2. Build: `cd solver && cargo build --release && cd ..` (one to three minutes). Do not change `Cargo.toml`, `Cargo.lock` or the source. Then run `cd solver && cargo test --release && cd ..` and confirm the tests pass.
3. Solve, from the folder's top level, as ONE command, in the background, with its output kept in a log:

   ```
   mkdir -p out
   ./solver/target/release/puzzle-solver solve --ranges data/ranges.json --puzzles data/puzzles.json --out out --only "$(cat ids-B.txt)" --skip-existing --target 0.15 >> out/solve.log 2>&1
   ```

   - On macOS put `caffeinate -i ` in front of the command so the machine does not sleep; on a laptop make sure it is on mains power.
   - It solves the hands one after another; each solve already uses all CPU cores. Do not start a second solver in parallel and do not split the list.
   - It prints a progress line every 10 iterations and, per hand, a line like `p128: ok  memory 1597 MB  iterations 300  exploitability 0.148% pot  171.2 s  decisions 5  warnings 0`. The last line of the run is `Done: N solved, M failed`.
   - If it is interrupted, run the same command again: `--skip-existing` skips the hands that are finished.
   - Wait for it with a single blocking wait on the process or on the `Done:` line, not by re-reading the log every few seconds.
4. Do not change the settings. In particular keep `--target 0.15` (the accuracy: 0.15% of the pot), do not add other flags, and do not edit `ranges.json` or `puzzles.json`. If a hand fails or prints a warning, leave it as it is and record it (see the manifest below). Do not try to repair it; the other session decides what to do with it.
5. Check the result: for every id in `ids-B.txt` that was solved there must be two files in `out/`: `<id>.json` and `<id>.summary.txt`. Each `<id>.json` must parse as JSON, have `"id"` equal to the file name, `"solver"."targetPctPot"` equal to `0.15`, and `"solver"."exploitabilityPctPot"` at most `0.15`.

## What to hand back — exactly this

One file named `solutions-B.zip` with a flat layout (no sub-folders):

```
solutions-B.zip
  manifest.json
  solve.log               the complete, unedited output of the solver (out/solve.log)
  p128.json               for every solved id: the solver's JSON output, unmodified
  p128.summary.txt        and its readable summary, unmodified
  p126.json
  p126.summary.txt
  ...
```

`manifest.json` must have exactly this shape:

```json
{
  "bundle": "pokerpuzzles-solve-B",
  "inputs": {
    "ranges.json": "<sha256 of data/ranges.json as you used it>",
    "puzzles.json": "<sha256 of data/puzzles.json as you used it>"
  },
  "command": "<the solve command exactly as you ran it>",
  "toolchain": { "rustc": "<output of rustc --version>", "cargo": "<output of cargo --version>" },
  "machine": "<CPU model, core count, RAM, OS>",
  "results": [
    { "id": "p128", "status": "ok", "exploitabilityPctPot": 0.148, "iterations": 300, "seconds": 171.2, "warnings": 0 },
    { "id": "p040", "status": "failed", "error": "<the solver's error line for this hand>" },
    { "id": "p102", "status": "not_run" }
  ]
}
```

- `results` has one entry for each of the 27 ids, in the order of `ids-B.txt`. `status` is `ok`, `failed` or `not_run`. For `ok` copy the numbers from that hand's `ok` line in the log.
- Do not edit, reformat or rename the `.json` and `.summary.txt` files: the other session reads them as written by the solver.
- A partial delivery is welcome. If time runs out or the person asks for what is done so far, pack the finished hands the same way and mark the rest `not_run`.

## When you are done

Tell the person where `solutions-B.zip` is, how many hands are `ok`, `failed` and `not_run`, how long it took, and anything unusual in the log. They will copy the zip back to the first computer into `~/Desktop/PokerPuzzles/handoff/incoming/` and tell the other session, which checks the manifest against its own checksums and merges the files.
