# Writing explanations

One file per hand, `data/v2/explanations/<id>.json` (format: `docs/SPEC.md`
section 2.3): one text per decision and a one-sentence takeaway. Write it from
the hand's fact sheet, `data/v2/facts/<id>.facts.txt`, and nothing else.

## Style

The owner wants to read why a play is right in poker terms, not what a solver
does.

- Explain the play: the hand's role here (value, bluff catcher, draw, give-up),
  and what each serious option leads to (who calls, who folds, what happens
  on later streets, position, stack depth).
- Use at most one or two numbers per decision, and only numbers that help, such
  as the price or the hand's equity.
- Never report solver behaviour ("the solver mixes", "is played 62%").
- When two options are equally good, explain the trade-off between them and
  say which one is usual.
- Length: 2 to 4 sentences per decision, at most 480 characters. The takeaway
  is one sentence of at most 160 characters. Plain ASCII, no markdown, no
  dash pairs.

## Accuracy rules

- What hero holds, hero's draws, outs and every number come only from the
  hero lines of the decision's section: `Hero's hand:`, `Draws:`, `Outs`,
  `Board:`, `New card`, the price and options lines, and the event lines
  around it.
- Statements about ranges come only from the range lines: `Hand types ...`,
  `Each option ...`, `Your hand type`, `Against your hand type`, `Blockers:`
  and the `villain hand types ...` lines.
- Never recommend against the sheet's best action. If "Best by EV" and the
  main line differ, both are fine (see the sheet header).
- Grade words are fixed:

  | Grade | Words |
  |---|---|
  | Correct | "fine too" |
  | Inaccuracy | "slightly worse" or "a small mistake" |
  | Wrong | "a mistake" |
  | Blunder | "a big mistake" |

## Recurring errors (found in review)

1. **Grade words drifting.** For example, an Inaccuracy called "a mistake", or a
   Correct option called "worse". Use the table above.
2. **Reading the action villain took as his betting range.**
   - The line `villain hand types taking this action: CHECK ...` describes the
     hands that checked, not his bets.
   - Use the separate `villain hand types that would BET ...` line, when the
     sheet has one, for what he bets with.
3. **Calling a pocket pair an "overpair" after an overcard has fallen.** Read
   the current street's `Hero's hand:` line every time, not the flop's.
4. **Copying "changes nothing" for a card that brought a draw.** Only write
   that a card is a blank when the `New card` line says "brick". Otherwise
   say what it changed, for example a second card of a suit (flush draw
   possible), new straight draws, or a draw hero picked up.

## Checks

1. Run `python3 tools/check-explanations.py data/v2/facts data/v2/explanations`.
   It must report 0 problems. It checks lengths, numbers and hand terms
   against the sheet.
2. Independent review: a second pass by someone who did not write the text.
   It tests every causal claim ("villain folds his draws", "a raise only gets
   called by better hands") against the range lines of that decision. Rewrite
   any claim the lines do not support.
