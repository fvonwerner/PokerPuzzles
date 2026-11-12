# Preflop solution used by the site

These files are the part of a 6-max, 100 bb, 2.5x-open cash game preflop
solver solution ("100bb 2.5x 500rake", NL500 rake) that the puzzle scenarios
need. They come unchanged from the open-source TexasSolver v0.2.0 release
(https://github.com/bupticybee/TexasSolver, release asset
TexasSolver-v0.2.0-MacOs.zip, folder `ranges/qb_ranges/100bb 2.5x 500rake`).

Each file lists every hand class with the share of the time it takes that
action. `tools/import-preflop.py` turns them into the charts in
`data/ranges.json`. `MP` in the file names is the hijack (HJ).
