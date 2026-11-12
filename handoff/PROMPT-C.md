Thank you, the 27 hands arrived, passed every check and are merged. Could you run a second, final batch the same way? Same folder (`pokerpuzzles-solve-B`), same solver binary, same inputs and settings; only the id list, the output folder and the name of the zip change.

1. In the folder's top level, create the file `ids-C.txt` containing exactly this one line (no line break inside it):

```
p197,p192,p189,p159,p184,p204,p201,p148,p151,p143,p177,p175,p133,p138,p122,p130,p162,p124,p119,p054,p216,p061,p170,p142,p207,p209,p080,p077,p157,p117,p109,p021,p193,p198,p104
```

2. Confirm the inputs are still untouched (`shasum -a 256 -c SHA256SUMS`, every line OK), then run, as before, as one background command:

```
mkdir -p outC
caffeinate -i ./solver/target/release/puzzle-solver solve --ranges data/ranges.json --puzzles data/puzzles.json --out outC --only "$(cat ids-C.txt)" --skip-existing --target 0.15 >> outC/solve.log 2>&1
```

   Same rules as before: one solver at a time, no other flags, no edits to the inputs, failed hands are left as they are and recorded, wait with a single blocking wait.

3. Hand back one file named `solutions-C.zip`, flat, with the same contents as last time: `manifest.json` (same shape, `"bundle": "pokerpuzzles-solve-C"`, one `results` entry for each of the 35 ids in the order of `ids-C.txt`), `solve.log`, and for every solved id its unmodified `<id>.json` and `<id>.summary.txt`.

The other computer is working through the same list from the opposite end, so a partial delivery is useful at any time: if the person asks for what is done so far, pack the finished hands and mark the rest `not_run`.
