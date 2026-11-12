# Learn section — content contract

The Learn section explains poker terms and the site's own charts in plain
language. Content lives in one static file, `web/learn/content.json`, written
by the content author and rendered by the web app (`#/learn`,
`#/learn/<topicId>`). The renderer must tolerate unknown block types (skip
them) and missing optional fields.

## File

```json
{
  "version": 1,
  "groups": [ { "id": "basics", "title": "The basics" } ],
  "paths":  [ { "id": "start", "title": "Start here", "topics": ["positions", "notation", "range"] } ],
  "topics": [ Topic, ... ]
}
```

`groups` order is the order in the topic list. `paths` are suggested reading
orders; the first path is the default "Start here" sequence.

## Topic

```json
{
  "id": "equity",
  "title": "Equity",
  "group": "basics",
  "short": "Your share of the pot if the hand were dealt out to the end many times.",
  "aliases": ["equity", "equities"],
  "simple":   [ Block, ... ],
  "deeper":   [ Block, ... ],
  "examples": [ Block, ... ],
  "check":    [ Quiz, ... ],
  "related":  ["outs", "pot-odds"]
}
```

- `id`: lowercase, digits and dashes. `short`: one sentence, at most 140
  characters, understandable alone (it is shown in pop-ups on the play screen).
- `aliases`: lowercase words or phrases that mean this topic. The play screen
  links them where they appear in an explanation (whole words, longest match
  first, first occurrence per text). Keep them specific: "value bet" yes,
  "bet" no.
- `simple`: the idea in everyday words, short (reads in under a minute).
  `deeper`: the detail and the maths. `examples`: worked examples.
  `check`: two to four questions. Only `simple` is required.

## Blocks

| Block | Fields |
|---|---|
| `p` | `text` |
| `h` | `text` (a small heading inside a section) |
| `list` | `items: [text]`, optional `ordered: true` |
| `tip` | `text` — a rule of thumb worth remembering |
| `warn` | `text` — a common mistake |
| `hand` | optional `title`, `hero: ["9h","8h"]`, optional `villain: [..]`, optional `board: ["Kh","7h","3c"]` (0, 3, 4 or 5 cards), optional `caption` |
| `calc` | optional `title`, `steps: [ { "label": "Outs", "value": "9 hearts" } ]`, `result` (the answer line) |
| `table` | `head: [text]`, `rows: [[text]]`, optional `caption` |
| `range` | optional `title`, `options: [ { "id": "raise", "kind": "raise", "label": "Raise" } ]`, `range: { "w": [169], "f": [169 arrays, one number per option] }`, optional `highlight: "AQo"`, optional `caption` |
| `quiz` | `q`, `options: [text]`, `answer` (index), `why` |

Text fields allow three inline marks and nothing else (no HTML):

- `**bold**`
- `[[topicId]]` or `[[topicId|shown text]]` — a link to another topic
- `{Ah}` — a card chip (rank then suit `shdc`), e.g. `{Ah}{Kd}`

`range` blocks use the same grid order and meaning as `docs/SPEC.md`
(section 1 "Grid order", section 3 "Range grids"): 169 entries, `w` is how
much of the hand class is in the range (0–1), `f[c][k]` how often it takes
option `k`. Option `kind` is one of `fold, check, call, bet, raise, allin`
(it picks the colour). A chart with a single option shows weights only.
