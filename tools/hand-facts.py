#!/usr/bin/env python3
"""hand-facts: compute a fact sheet for every solver-graded puzzle hand.

    python3 tools/hand-facts.py <solutions-dir> --out <facts-dir> [--only id1,id2]

For each <id>.json solution file (format: docs/SPEC.md section 3) this writes
<facts-dir>/<id>.facts.json (machine-readable) and <facts-dir>/<id>.facts.txt
(the same content, laid out for reading). Every fact is either copied from the
solution file or computed from the cards. Nothing is taken from summary text or
from explanations. Standard library only.

Card logic (hand names, draws, outs, board texture) lives in the functions
below `# ---- cards` and is tested by tools/test_hand_facts.py.
"""

import argparse
import functools
import itertools
import json
import math
import os
import sys

# ---------------------------------------------------------------------------
# ---- cards

RANKS = "23456789TJQKA"
RANK_VAL = {r: i + 2 for i, r in enumerate(RANKS)}
VAL_CHAR = {v: r for r, v in RANK_VAL.items()}
SUITS = "shdc"
SUIT_NAME = {"s": "spades", "h": "hearts", "d": "diamonds", "c": "clubs"}
SUIT_ONE = {"s": "spade", "h": "heart", "d": "diamond", "c": "club"}
NAME = {14: "ace", 13: "king", 12: "queen", 11: "jack", 10: "ten", 9: "nine",
        8: "eight", 7: "seven", 6: "six", 5: "five", 4: "four", 3: "three", 2: "two", 1: "ace"}
PLURAL = {14: "aces", 13: "kings", 12: "queens", 11: "jacks", 10: "tens", 9: "nines",
          8: "eights", 7: "sevens", 6: "sixes", 5: "fives", 4: "fours", 3: "threes", 2: "twos"}
ORDINAL = {1: "second", 2: "third", 3: "fourth", 4: "fifth"}

HIGH, PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH, FULL_HOUSE, QUADS, STRAIGHT_FLUSH = range(9)
CAT_NAME = ["high card", "pair", "two pair", "three of a kind", "straight", "flush",
            "full house", "four of a kind", "straight flush"]

FULL_DECK = [r + s for r in RANKS for s in SUITS]


def parse(card):
    """'Ah' -> (14, 'h')."""
    if len(card) != 2 or card[0] not in RANK_VAL or card[1] not in SUITS:
        raise ValueError(f"bad card {card!r}")
    return (RANK_VAL[card[0]], card[1])


def cstr(c):
    return VAL_CHAR[c[0]] + c[1]


def straight_high(rankset):
    """Highest straight in a set of rank values (ace plays high or low), or None."""
    m = 0
    for r in rankset:
        m |= 1 << r
    if m & (1 << 14):
        m |= 2  # the ace also plays as 1
    for hi in range(14, 4, -1):
        mask = 0b11111 << (hi - 4)
        if m & mask == mask:
            return hi
    return None


def eval5(cards):
    """Value of exactly five cards: (category, tiebreak ranks...). Higher is better."""
    ranks = sorted((c[0] for c in cards), reverse=True)
    flush = len({c[1] for c in cards}) == 1
    sh = straight_high(ranks) if len(set(ranks)) == 5 else None
    if flush and sh:
        return (STRAIGHT_FLUSH, sh)
    counts = {}
    for r in ranks:
        counts[r] = counts.get(r, 0) + 1
    groups = sorted(counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    shape = [g[1] for g in groups]
    order = tuple(g[0] for g in groups)
    if shape == [4, 1]:
        return (QUADS,) + order
    if shape == [3, 2]:
        return (FULL_HOUSE,) + order
    if flush:
        return (FLUSH,) + tuple(ranks)
    if sh:
        return (STRAIGHT, sh)
    if shape == [3, 1, 1]:
        return (TRIPS,) + order
    if shape == [2, 2, 1]:
        return (TWO_PAIR,) + order
    if shape == [2, 1, 1, 1]:
        return (PAIR,) + order
    return (HIGH,) + tuple(ranks)


def eval_partial(cards):
    """Value of fewer than five cards (only rank groups can count)."""
    counts = {}
    for c in cards:
        counts[c[0]] = counts.get(c[0], 0) + 1
    groups = sorted(counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    shape = [g[1] for g in groups]
    order = tuple(g[0] for g in groups)
    if shape and shape[0] == 4:
        return (QUADS,) + order
    if shape and shape[0] == 3:
        return (TRIPS,) + order
    if shape[:2] == [2, 2]:
        return (TWO_PAIR,) + order
    if shape and shape[0] == 2:
        return (PAIR,) + order
    return (HIGH,) + order


def best_hand(cards, hole=()):
    """Best five-card hand from 5-7 cards. Returns (value, five_cards).
    Among equal-value choices it takes the one using the FEWEST hole cards, so
    the hole cards it reports are the ones that actually matter."""
    if len(cards) < 5:
        return eval_partial(cards), list(cards)
    hole = set(hole)
    best = None
    for combo in itertools.combinations(cards, 5):
        v = eval5(combo)
        nh = sum(1 for c in combo if c in hole)
        key = (v, -nh)
        if best is None or key > best[0]:
            best = (key, list(combo))
    return best[0][0], best[1]


def value_of(cards):
    return best_hand(cards)[0]


def fast_value(cards):
    """Same result as value_of() for 5 to 7 cards, computed directly from rank
    and suit counts (used for whole-range hand types, where speed matters)."""
    counts = {}
    suits = {}
    for r, s in cards:
        counts[r] = counts.get(r, 0) + 1
        suits.setdefault(s, []).append(r)
    for s, rs in suits.items():
        if len(rs) >= 5:
            sh = straight_high(rs)
            if sh:
                return (STRAIGHT_FLUSH, sh)
            flush = (FLUSH,) + tuple(sorted(rs, reverse=True)[:5])
            break
    else:
        flush = None
    by = sorted(counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    desc = sorted(counts, reverse=True)
    if by[0][1] == 4:
        q = by[0][0]
        return (QUADS, q, max(r for r in desc if r != q))
    if by[0][1] == 3:
        t = by[0][0]
        others = [r for r, n in by[1:] if n >= 2]
        if others:
            return (FULL_HOUSE, t, max(others))
    if flush:
        return flush
    sh = straight_high(desc)
    if sh:
        return (STRAIGHT, sh)
    if by[0][1] == 3:
        t = by[0][0]
        return (TRIPS, t) + tuple([r for r in desc if r != t][:2])
    pairs = sorted([r for r, n in counts.items() if n == 2], reverse=True)
    if len(pairs) >= 2:
        p1, p2 = pairs[0], pairs[1]
        return (TWO_PAIR, p1, p2, max(r for r in desc if r not in (p1, p2)))
    if pairs:
        p = pairs[0]
        return (PAIR, p) + tuple([r for r in desc if r != p][:3])
    return (HIGH,) + tuple(desc[:5])


def rank_list(vals):
    return " ".join(VAL_CHAR[v] for v in vals)


def card_names(cards):
    return " ".join(cstr(c) for c in cards)


def preflop_facts(hole):
    a, b = sorted(hole, key=lambda c: c[0], reverse=True)
    if a[0] == b[0]:
        kind = f"pocket pair ({PLURAL[a[0]]})"
    else:
        suited = "suited" if a[1] == b[1] else "offsuit"
        gap = a[0] - b[0] - 1
        conn = "connected" if gap == 0 else f"{gap}-gap" if gap <= 3 else "unconnected"
        kind = f"{NAME[a[0]]}-{NAME[b[0]]} {suited} ({conn})"
    return {"street": "preflop", "description": kind + "; no board yet, so no made hand or draws"}


def _distinct_desc(vals):
    return sorted(set(vals), reverse=True)


def made_hand(hole, board):
    """Describe hero's made hand from the cards. hole: 2 parsed cards, board: 3-5."""
    allc = list(hole) + list(board)
    value, five = best_hand(allc, hole)
    cat = value[0]
    hole_ranks = [c[0] for c in hole]
    board_ranks = [c[0] for c in board]
    bdesc = _distinct_desc(board_ranks)
    used = [c for c in five if c in hole]
    plays_board = False
    if len(board) == 5:
        bval = eval5(board)
        if bval == value:
            plays_board = True
            used = []
    out = {"category": CAT_NAME[cat], "bestFive": [cstr(c) for c in sorted(five, key=lambda c: -c[0])],
           "holeCardsUsed": [cstr(c) for c in used], "playsTheBoard": plays_board}
    hc = lambda r: hole_ranks.count(r)  # noqa: E731 hole cards of rank r
    desc = ""
    if cat == STRAIGHT_FLUSH:
        hi = value[1]
        desc = "royal flush" if hi == 14 else f"straight flush, {NAME[hi]}-high"
    elif cat == QUADS:
        q = value[1]
        n = hc(q)
        if n == 2:
            desc = f"four of a kind ({PLURAL[q]}): pocket pair + two board cards"
        elif n == 1:
            desc = f"four of a kind ({PLURAL[q]}): one hole card + three on the board"
        else:
            desc = f"four of a kind ({PLURAL[q]}) on the board; kicker {NAME[value[2]]}"
    elif cat == FULL_HOUSE:
        t, p = value[1], value[2]
        parts = []
        if hc(t):
            parts.append(f"{hc(t)} hole card{'s' if hc(t) > 1 else ''} in the {PLURAL[t]}")
        if hc(p):
            parts.append(f"{hc(p)} hole card{'s' if hc(p) > 1 else ''} in the {PLURAL[p]}")
        desc = f"full house, {PLURAL[t]} full of {PLURAL[p]}" + (f" ({'; '.join(parts)})" if parts else "")
    elif cat == FLUSH:
        suit = five[0][1]
        suited_hole = sorted([c for c in hole if c[1] == suit], key=lambda c: -c[0])
        in_five = [c for c in suited_hole if c in five]
        fl = flush_nut_info(hole, board, suit)
        hi = max(c[0] for c in five)
        if not in_five:
            desc = f"flush ({SUIT_NAME[suit]}, {NAME[hi]}-high) entirely on the board"
        elif len(in_five) == 2:
            desc = f"flush ({SUIT_NAME[suit]}) with both hole cards ({card_names(in_five)})"
        else:
            desc = f"flush ({SUIT_NAME[suit]}) with one hole card, the {cstr(in_five[0])}"
        if in_five:
            desc += "; the nut flush" if fl["nut"] else \
                f"; not the nut flush (higher {SUIT_ONE[suit]}s unseen: {rank_list(fl['higherUnseen'])})"
        out["nutFlush"] = fl["nut"] if in_five else False
    elif cat == STRAIGHT:
        hi = value[1]
        nut = nut_straight_high(hole, board)
        desc = f"straight, {NAME[hi]}-high"
        if used:
            desc += f" (using {card_names(used)})"
            desc += "; the nut straight" if hi >= nut else f"; not the nut straight ({NAME[nut]}-high is possible)"
        out["nutStraight"] = bool(used) and hi >= nut
    elif cat == TRIPS:
        t = value[1]
        n = hc(t)
        if n == 2:
            desc = f"set of {PLURAL[t]} (pocket pair + one board card)"
        elif n == 1:
            kick = [r for r in hole_ranks if r != t][0]
            desc = f"trips, {PLURAL[t]} (one hole card + a pair on the board); kicker {NAME[kick]}"
            out["kicker"] = NAME[kick]
        else:
            desc = f"three of a kind ({PLURAL[t]}) on the board; your cards only add kickers"
    elif cat == TWO_PAIR:
        p1, p2 = value[1], value[2]

        def origin(r):
            n = hc(r)
            return "pocket pair" if n == 2 else ("one hole card" if n == 1 else "board pair")
        o1, o2 = origin(p1), origin(p2)
        if o1 == "one hole card" and o2 == "one hole card":
            desc = f"two pair, {PLURAL[p1]} and {PLURAL[p2]}, with both hole cards"
        elif o1 == "board pair" and o2 == "board pair":
            desc = f"two pair, {PLURAL[p1]} and {PLURAL[p2]}, both pairs on the board"
            k = value[3]
            desc += f"; kicker {NAME[k]}" + (" (yours)" if k in hole_ranks and k not in board_ranks else " (on the board)")
        else:
            desc = f"two pair, {PLURAL[p1]} ({o1}) and {PLURAL[p2]} ({o2})"
            own = p1 if o1 != "board pair" else p2
            if hc(own) == 1:
                desc += f"; your own pair is {pair_position(own, board_ranks)}"
            elif hc(own) == 2:
                desc += "; your pocket pair is " + pocket_position(own, board_ranks)
        # counterfeit: a pair made with a hole card that no longer plays
        counts = {}
        for c in allc:
            counts[c[0]] = counts.get(c[0], 0) + 1
        dropped = [r for r, n in counts.items() if n >= 2 and r not in (p1, p2) and hc(r) >= 1]
        if dropped:
            r = max(dropped)
            desc += (f"; counterfeited: your pair of {PLURAL[r]} no longer plays "
                     f"(the board's pairs outrank it)")
            out["counterfeited"] = PLURAL[r]
    elif cat == PAIR:
        p = value[1]
        n = hc(p)
        if n == 2:
            desc = pocket_position(p, board_ranks, sentence=True)
        elif n == 1:
            kick = [r for r in hole_ranks if r != p][0]
            pos = pair_position(p, board_ranks)
            desc = f"{pos}, {NAME[kick]} kicker"
            out["kicker"] = NAME[kick]
            if kick not in [c[0] for c in five]:
                desc += " (the kicker does not play: board cards outrank it)"
            out["pairPosition"] = pos.split(" (")[0]
        else:
            hi = max(hole_ranks)
            desc = f"no pair of your own (the only pair is the board's {PLURAL[p]}); {NAME[hi]}-high"
    else:
        hi = max(hole_ranks)
        desc = f"no pair: {NAME[hi]}-high"
        above = [r for r in bdesc if r > hi]
        if above:
            desc += f" (board cards above your best card: {rank_list(above)})"
    if plays_board:
        desc = "you play the board: " + desc + " (your hole cards do not improve it)"
    out["description"] = desc
    return out


def pair_position(r, board_ranks):
    """Name of the pair made by pairing board rank r with one hole card."""
    d = _distinct_desc(board_ranks)
    i = d.index(r)
    if i == 0:
        return "top pair"
    if i == len(d) - 1:
        return "bottom pair" + (f" ({ORDINAL[i]} pair)" if i >= 2 else "")
    return f"{ORDINAL[i]} pair"


def pocket_position(p, board_ranks, sentence=False):
    above = [r for r in _distinct_desc(board_ranks) if r > p]
    if not above:
        return f"overpair (pocket {PLURAL[p]})" if sentence else "an overpair"
    d = _distinct_desc(board_ranks)
    n = len(above)
    words = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}
    if n == len(d):
        txt = f"pocket {PLURAL[p]} below every board card (underpair to {words[n]} board card{'s' if n > 1 else ''}: {rank_list(above)})"
    else:
        below = [r for r in d if r < p]
        txt = (f"pocket {PLURAL[p]} below the top card (underpair to {words[n]} board "
               f"card{'s' if n > 1 else ''}: {rank_list(above)}"
               + (f"; above {rank_list(below)}" if below else "") + ")")
    return txt if sentence else txt.replace(f"pocket {PLURAL[p]} ", "", 1)


def flush_nut_info(hole, board, suit):
    seen = set(hole) | set(board)
    unseen = sorted([v for v in range(2, 15) if (v, suit) not in seen], reverse=True)
    mine = [c[0] for c in hole if c[1] == suit]
    top = max(mine) if mine else 0
    higher = [v for v in unseen if v > top]
    return {"nut": not higher, "higherUnseen": higher}


def nut_straight_high(hole, board):
    """Highest straight any two unseen cards could make with this board."""
    seen = list(hole) + list(board)
    bset = {c[0] for c in board}
    avail = [v for v in range(2, 15) if sum(1 for c in seen if c[0] == v) < 4]
    best = straight_high(bset) or 0
    for a, b in itertools.combinations_with_replacement(avail, 2):
        sh = straight_high(bset | {a, b})
        if sh and sh > best:
            best = sh
    return best


def straight_completers(hole, board):
    """Ranks that give hero a straight (using a hole card) that the board alone would not."""
    return list(_completers(frozenset(c[0] for c in hole), frozenset(c[0] for c in board)))


@functools.lru_cache(maxsize=65536)
def _completers(H, B):
    C = []
    for r in range(2, 15):
        if r in H or r in B:
            continue
        hb = straight_high(H | B | {r})
        bb = straight_high(B | {r})
        if hb and (bb is None or hb > bb):
            C.append(r)
    return tuple(C)


def hero_has_straight(hole, board):
    H = {c[0] for c in hole}
    B = {c[0] for c in board}
    hb = straight_high(H | B)
    bb = straight_high(B)
    return bool(hb and (bb is None or hb > bb))


def draws(hole, board):
    """Draws for hero. Flop: flush, straight, backdoor flush, backdoor straight.
    Turn: flush and straight only. River: none."""
    street = {3: "flop", 4: "turn", 5: "river"}[len(board)]
    res = {"street": street, "flushDraw": None, "straightDraw": None, "comboDraw": False,
           "backdoorFlushDraws": [], "backdoorStraightDraw": None, "overcards": [], "list": []}
    hole_ranks = [c[0] for c in hole]
    board_ranks = [c[0] for c in board]
    maxb = max(board_ranks)
    res["overcards"] = [NAME[r] for r in sorted(set(hole_ranks), reverse=True)
                        if r > maxb and hole_ranks.count(r) == 1]
    if street == "river":
        res["list"] = []
        res["summary"] = "no draws: river (no cards to come)"
        return res
    cur = value_of(list(hole) + list(board))
    cat = cur[0]
    # flush draw
    if cat < FLUSH:
        for s in SUITS:
            hs = [c for c in hole if c[1] == s]
            n = len(hs) + sum(1 for c in board if c[1] == s)
            if n == 4 and hs:
                info = flush_nut_info(hole, board, s)
                res["flushDraw"] = {
                    "suit": SUIT_NAME[s], "holeCards": [cstr(c) for c in hs],
                    "holeCardCount": len(hs), "nut": info["nut"],
                    "higherUnseen": rank_list(info["higherUnseen"]),
                    "outs": 9}
                txt = f"{'nut ' if info['nut'] else ''}flush draw in {SUIT_NAME[s]}"
                txt += " with both hole cards" if len(hs) == 2 else f" with one hole card only (the {cstr(hs[0])}; three {SUIT_NAME[s]} on the board)"
                if not info["nut"]:
                    txt += f"; not the nut draw (higher {SUIT_ONE[s]}s unseen: {rank_list(info['higherUnseen'])})"
                res["list"].append(txt)
    # straight draw
    if cat < STRAIGHT and not hero_has_straight(hole, board):
        C = straight_completers(hole, board)
        if C:
            held = {c[0] for c in hole} | {c[0] for c in board}
            heldv = held | ({1} if 14 in held else set())
            Cv = set(C) | ({1} if 14 in C else set())
            oe = []
            for lo in sorted(Cv):
                hi = lo + 5
                if hi in Cv and all(lo + k in heldv for k in range(1, 5)):
                    oe.append((lo, hi))
            ranks_txt = " or ".join(NAME[r] for r in sorted(C, reverse=True))
            outs = 4 * len(C)
            covered = {14 if x == 1 else x for pr in oe for x in pr}
            extra = [r for r in C if r not in covered]
            if oe:
                kind = "open-ended straight draw" + (" plus gutshot" if extra else "")
            elif len(C) == 1:
                r = C[0]
                rv = {r} | ({1} if r == 14 else set())
                one_ended = any(all(x + k in heldv for k in range(1, 5)) or all(x - k in heldv for k in range(1, 5)) for x in rv)
                kind = "gutshot straight draw" + (" (one-ended: only one rank completes it)" if one_ended else "")
            elif len(C) == 2:
                kind = "double gutshot straight draw"
            else:
                kind = f"straight draw with {len(C)} completing ranks"
            res["straightDraw"] = {"type": kind.split(" (")[0], "completingRanks": [VAL_CHAR[r] for r in sorted(C, reverse=True)],
                                   "outs": outs, "description": f"{kind}: any {ranks_txt} ({outs} cards)"}
            res["list"].append(res["straightDraw"]["description"])
    if res["flushDraw"] and res["straightDraw"]:
        res["comboDraw"] = True
        res["list"].append("combo draw (flush draw + " + res["straightDraw"]["type"] + ")")
    if street == "flop":
        if cat < FLUSH and not res["flushDraw"]:
            for s in SUITS:
                hs = [c for c in hole if c[1] == s]
                n = len(hs) + sum(1 for c in board if c[1] == s)
                if n == 3 and hs:
                    info = flush_nut_info(hole, board, s)
                    txt = (f"backdoor flush draw in {SUIT_NAME[s]} ("
                           + ("both hole cards" if len(hs) == 2 else f"one hole card, the {cstr(hs[0])}")
                           + ("; nut" if info["nut"] else "") + "): needs two more " + SUIT_NAME[s])
                    res["backdoorFlushDraws"].append({"suit": SUIT_NAME[s], "holeCardCount": len(hs), "nut": info["nut"]})
                    res["list"].append(txt)
        if cat < STRAIGHT and not res["straightDraw"]:
            bd = backdoor_straight_windows(hole, board)
            if bd:
                res["backdoorStraightDraw"] = bd
                res["list"].append("backdoor straight draw: needs runner-runner " + ", ".join(bd))
    if res["overcards"] and cat == HIGH:
        n = len(res["overcards"])
        res["list"].append(f"{'one overcard' if n == 1 else 'two overcards'} ({', '.join(res['overcards'])})")
    res["summary"] = "; ".join(res["list"]) if res["list"] else "no draw"
    return res


def backdoor_straight_windows(hole, board):
    """Flop only: rank pairs that would complete a straight using a hole card."""
    H = {c[0] for c in hole}
    B = {c[0] for c in board}
    held = H | B
    out = []
    for hi in range(14, 4, -1):
        w = [hi - k for k in range(5)]
        wv = [14 if x == 1 else x for x in w]
        have = [x for x in wv if x in held]
        if len(set(have)) != 3:
            continue
        if not any(x in H and x not in B for x in wv):
            continue
        need = sorted({x for x in wv if x not in held}, reverse=True)
        # the completed straight must use a hole card and beat what the board
        # plus those two cards gives everyone (A-x on 6-5-4 needing 3-2 does not)
        hb = straight_high(held | set(need))
        bb = straight_high(B | set(need))
        if not hb or (bb is not None and hb <= bb):
            continue
        txt = "-".join(VAL_CHAR[x] for x in need)
        if txt not in out:  # two windows can need the same two ranks
            out.append(txt)
    return out


def unseen_cards(hole, board):
    seen = {cstr(c) for c in list(hole) + list(board)}
    return [parse(c) for c in FULL_DECK if c not in seen]


def outs(hole, board):
    """Classify every unseen card by what it does for hero on the next card.
    Each card lands in at most one bucket (its best improvement)."""
    if len(board) >= 5:
        return None
    hole_ranks = {c[0] for c in hole}
    cur = value_of(list(hole) + list(board))
    board_ranks = [c[0] for c in board]
    cur_own_pair = cur[0] >= PAIR and _has_own_pair(hole, board)
    buckets = {"straightOrBetter": [], "twoPairOrTrips": [], "topPair": [], "otherPair": []}
    for card in unseen_cards(hole, board):
        nb = list(board) + [card]
        new = value_of(list(hole) + nb)
        if new[0] >= STRAIGHT and new[0] > cur[0] and _hole_matters(hole, nb, new):
            buckets["straightOrBetter"].append(cstr(card))
            continue
        if card[0] not in hole_ranks or not new > cur:
            continue
        if not cur_own_pair:
            if card[0] >= max(board_ranks):
                buckets["topPair"].append(cstr(card))
            else:
                buckets["otherPair"].append(cstr(card))
        elif (new[0] == TRIPS and new[1] == card[0]) or (new[0] == TWO_PAIR and card[0] in new[1:3]):
            buckets["twoPairOrTrips"].append(cstr(card))
    res = {k: {"cards": v, "count": len(v)} for k, v in buckets.items()}
    nxt = {STRAIGHT: "a flush", FLUSH: "a full house", FULL_HOUSE: "four of a kind", QUADS: "a straight flush"}
    res["straightOrBetter"]["label"] = f"to {nxt.get(cur[0], 'a better hand')} or better" if cur[0] >= STRAIGHT else "to a straight or better"
    res["unseenCount"] = len(unseen_cards(hole, board))
    return res


def _has_own_pair(hole, board):
    hr = [c[0] for c in hole]
    br = {c[0] for c in board}
    return hr[0] == hr[1] or hr[0] in br or hr[1] in br


def _hole_matters(hole, nb, new):
    """True when hero's improved hand is better than what the board+card gives
    anyone holding two useless cards (i.e., the improvement uses a hole card)."""
    if len(nb) >= 5:
        return new > value_of(nb)
    # 4 board cards: compare categories made by the board alone
    return new[0] > eval_partial(nb)[0]


# ---- board texture

def straight_combos(board):
    """Rank combos (one or two cards) that make a straight with this board."""
    B = {c[0] for c in board}
    base = straight_high(B)
    singles = []
    for r in range(2, 15):
        if r in B:
            continue
        sh = straight_high(B | {r})
        if sh and (base is None or sh > base):
            singles.append(r)
    pairs = []
    for a, b in itertools.combinations(range(2, 15), 2):
        if a in B or b in B or a in singles or b in singles:
            continue
        sh = straight_high(B | {a, b})
        if sh and (base is None or sh > base):
            pairs.append((b, a))
    pairs.sort(key=lambda x: (-x[0], -x[1]))
    return base, singles, pairs


def straight_list(singles, pairs):
    """'one card: 7; two cards: QJ, T9' - the same wording on the Board and New card lines."""
    parts = []
    if singles:
        parts.append("one card: " + ", ".join(VAL_CHAR[r] for r in sorted(singles, reverse=True)))
    if pairs:
        parts.append("two cards: " + ", ".join(VAL_CHAR[a] + VAL_CHAR[b] for a, b in pairs))
    return "; ".join(parts)


def max_in_window(board):
    B = {c[0] for c in board}
    if 14 in B:
        B = B | {1}
    best = 0
    for hi in range(5, 15):
        best = max(best, sum(1 for k in range(5) if hi - k in B))
    return best


def texture(board):
    ranks = [c[0] for c in board]
    counts = {}
    for r in ranks:
        counts[r] = counts.get(r, 0) + 1
    shape = sorted(counts.values(), reverse=True)
    notes = []
    if shape[0] == 4:
        pairing = "four of a kind on the board"
    elif shape[0] == 3 and len(shape) > 1 and shape[1] >= 2:
        pairing = "full house on the board"
    elif shape[0] == 3:
        pairing = "trips on the board"
    elif shape[:2] == [2, 2]:
        pairing = "two pair on the board"
    elif shape[0] == 2:
        pairing = f"paired board ({PLURAL[[r for r, n in counts.items() if n == 2][0]]})"
    else:
        pairing = "unpaired board"
    notes.append(pairing)
    sc = {s: sum(1 for c in board if c[1] == s) for s in SUITS}
    mx = max(sc.values())
    msuit = [s for s in SUITS if sc[s] == mx][0]
    n = len(board)
    if n == 3:
        suits = {3: "monotone", 2: "two-tone", 1: "rainbow"}[mx]
    elif n == 4:
        pattern = sorted([v for v in sc.values() if v], reverse=True)
        suits = {(4,): "four of one suit", (3, 1): "three of one suit", (2, 2): "two suits, two cards each",
                 (2, 1, 1): "two of one suit", (1, 1, 1, 1): "rainbow (four suits)"}[tuple(pattern)]
    else:
        suits = f"at most {mx} of one suit"
    notes.append(suits)
    if mx >= 5:
        fl = f"flush on the board ({SUIT_NAME[msuit]})"
    elif mx == 4:
        fl = f"four to a flush ({SUIT_NAME[msuit]}): any single {SUIT_ONE[msuit]} makes a flush"
    elif mx == 3:
        fl = f"three to a flush ({SUIT_NAME[msuit]}): two {SUIT_NAME[msuit]} in hand make a flush"
    elif n < 5:
        two = [SUIT_NAME[s] for s in SUITS if sc[s] == 2]
        fl = ("no flush possible yet; flush draws possible in " + ", ".join(two)) if two else \
            ("no flush possible yet; only backdoor flush draws" if n == 3 else "no flush possible yet and no flush draw possible")
    else:
        fl = "no flush possible"
    notes.append(fl)
    base, singles, pairs = straight_combos(board)
    w = max_in_window(board)
    if base:
        st = f"straight on the board ({NAME[base]}-high)"
        if singles or pairs:
            st += f"; higher straights possible ({straight_list(singles, pairs)})"
    elif singles:
        st = f"four to a straight: one card makes a straight (straights with {straight_list(singles, pairs)})"
    elif pairs:
        st = f"three to a straight: two-card straights possible (straights with {straight_list(singles, pairs)})"
    else:
        st = "no straight possible yet" if n < 5 else "no straight possible"
    notes.append(st)
    return {"pairing": pairing, "suits": suits, "suitCounts": {SUIT_NAME[s]: sc[s] for s in SUITS if sc[s]},
            "flush": fl, "straight": st, "maxRanksInAStraightWindow": w,
            "straightSingleCards": [VAL_CHAR[r] for r in sorted(singles, reverse=True)],
            "straightTwoCardCombos": [VAL_CHAR[a] + VAL_CHAR[b] for a, b in pairs],
            "summary": "; ".join(notes)}


def own_pair_rank(hole, board):
    """Rank of hero's own pair (pocket pair or a hole card pairing the board), highest."""
    hr = [c[0] for c in hole]
    br = {c[0] for c in board}
    cands = []
    if hr[0] == hr[1]:
        cands.append(hr[0])
    cands += [r for r in hr if r in br]
    return max(cands) if cands else None


def new_card_facts(hole, prev_board, board):
    """What the newest card (turn or river) changed, on the board and for hero.
    'brick' only when it changes no pair, straight, flush or draw on the board
    and gives hero nothing (no improvement, no new draw)."""
    new = board[-1]
    prev = list(prev_board)
    prank = [c[0] for c in prev]
    ch = []
    pairs_board = new[0] in prank
    if pairs_board:
        ch.append(f"pairs the board ({PLURAL[new[0]]})")
    top = new[0] > max(prank)
    if top:
        ch.append(f"overcard to the board (new top card, {NAME[new[0]]})")
    opr = own_pair_rank(hole, prev)
    over_pair = opr is not None and new[0] > opr and new[0] not in {c[0] for c in hole}
    if over_pair:
        ch.append(f"overcard to your pair of {PLURAL[opr]}")
    n_suit = sum(1 for c in prev if c[1] == new[1]) + 1
    flush_change = None
    if n_suit == 3:
        flush_change = f"third {SUIT_ONE[new[1]]}: a flush is now possible"
    elif n_suit == 4:
        flush_change = f"fourth {SUIT_ONE[new[1]]}: any single {SUIT_ONE[new[1]]} now makes a flush"
    elif n_suit == 5:
        flush_change = f"fifth {SUIT_ONE[new[1]]}: flush on the board"
    elif n_suit == 2 and len(board) == 4:
        flush_change = f"second {SUIT_ONE[new[1]]}: a flush draw in {SUIT_NAME[new[1]]} is now possible"
    if flush_change:
        ch.append(flush_change)
    _, s0, p0 = straight_combos(prev)
    b1, s1, p1 = straight_combos(board)
    b0 = straight_high({c[0] for c in prev})
    before = set(map(tuple, ([(r,) for r in s0] + p0)))
    straight_change = None
    if b1 and not b0:
        straight_change = "makes a straight on the board"
    else:
        news = [r for r in s1 if not any(set(o) <= {r} for o in before)]
        newp = [c for c in p1 if not any(set(o) <= set(c) for o in before)]
        if news or newp:
            straight_change = f"makes new straights possible ({straight_list(news, newp)})"
    if straight_change:
        ch.append(straight_change)
    # new straight DRAWS for some holding are not counted as a board change:
    # nearly every turn card gives some two cards a new draw
    hb = value_of(list(hole) + prev)
    ha = value_of(list(hole) + list(board))
    md_b = made_hand(hole, prev)["description"]
    md_a = made_hand(hole, list(board))["description"]
    # improved = the new card was one of hero's outs on the previous street
    o_prev = outs(hole, prev)
    hero_improved = any(cstr(new) in o_prev[k]["cards"] for k in ("straightOrBetter", "twoPairOrTrips", "topPair", "otherPair"))
    dprev = draws(hole, prev)
    picked = []
    if len(board) < 5:
        dnow = draws(hole, list(board))
        if dnow["flushDraw"] and not dprev["flushDraw"]:
            fd = dnow["flushDraw"]
            picked.append(f"a {'nut ' if fd['nut'] else ''}flush draw" + ("" if fd["holeCardCount"] == 2 else " (one hole card)"))
        sdn, sdp = dnow["straightDraw"], dprev["straightDraw"]
        if sdn and (not sdp or sdn["outs"] > sdp["outs"]):
            picked.append(f"a {sdn['type']}")
        if dnow["comboDraw"] and not dprev["comboDraw"]:
            picked.append("a combo draw")
    draw_notes = []
    for key, label in (("flushDraw", "flush draw"), ("straightDraw", "straight draw")):
        if not dprev[key]:
            continue
        made_cat = FLUSH if key == "flushDraw" else STRAIGHT
        if ha[0] >= made_cat and hero_improved:
            draw_notes.append(f"completes your {label}")
        elif len(board) == 5:
            draw_notes.append(f"your {label} missed")
        else:
            draw_notes.append(f"your {label} did not come in")
    board_change = bool(ch)
    brick = not board_change and not hero_improved and not picked
    if brick:
        summary = "brick: changes nothing on the board and does not improve your hand"
    else:
        summary = ("; ".join(ch) or "no change on the board") + f"; your hand: {md_b} -> {md_a}"
        if hero_improved:
            summary += " (improved)"
        elif picked:
            summary += " (made hand not improved)"
        else:
            summary += " (no improvement)"
        if picked:
            summary += "; you pick up " + " and ".join(picked)
    summary += "".join(f"; {x}" for x in draw_notes)
    return {"card": cstr(new), "pairsBoard": pairs_board, "newTopCard": top,
            "overcardToYourPair": over_pair, "flushChange": flush_change, "straightChange": straight_change,
            "heroCategoryBefore": CAT_NAME[hb[0]], "heroCategoryAfter": CAT_NAME[ha[0]],
            "heroHandBefore": md_b, "heroHandAfter": md_a, "pickedUpDraws": picked,
            "heroImproved": hero_improved, "brick": brick, "previousDraws": draw_notes,
            "summary": summary}


def hand_facts(hole_strs, board_strs, prev_board_strs=None):
    """All card facts for hero at one point of the hand."""
    hole = [parse(c) for c in hole_strs]
    board = [parse(c) for c in board_strs]
    if not board:
        return {"preflop": preflop_facts(hole)}
    res = {"made": made_hand(hole, board), "draws": draws(hole, board),
           "outs": outs(hole, board), "texture": texture(board)}
    if prev_board_strs and len(prev_board_strs) >= 3:
        res["newCard"] = new_card_facts(hole, [parse(c) for c in prev_board_strs], board)
    return res


# ---------------------------------------------------------------------------
# ---- grading (mirrors server/lib/grading.mjs exactly; keep in sync with it)

GRADING = {"bestWithin": 0.05, "correctMinFreq": 0.035, "correctBase": 60, "correctSpan": 40,
           "correctMaxLossPct": 0.2,  # solver: lossPct <= this is at least Correct (the solver's accuracy)
           "inaccuracyMaxLossPct": 1.5, "wrongMaxLossPct": 6,
           "points": {"best": 100, "inaccuracy": 40, "wrong": 15, "blunder": 0}, "epsilon": 1e-9}
GRADE_LABELS = {"best": "Best", "correct": "Correct", "inaccuracy": "Inaccuracy", "wrong": "Wrong", "blunder": "Blunder"}


def js_round(x):
    """JavaScript Math.round: nearest integer, ties toward +infinity."""
    f = math.floor(x)
    return f + 1 if x - f >= 0.5 else f


def round2(x):
    return js_round(x * 100) / 100


def grade_decision(decision, option_id, C=GRADING):
    """Python port of gradeDecision() in server/lib/grading.mjs."""
    ids = [o["id"] for o in decision["options"]]
    k = ids.index(option_id)
    freqs = decision["hand"]["freq"]
    freq = freqs[k]
    max_freq = max(freqs)
    is_chart = decision.get("source") == "chart"
    loss = loss_pct = None
    if not is_chart and isinstance(decision["hand"].get("ev"), list):
        evs = decision["hand"]["ev"]
        loss = max(0, max(evs) - evs[k])
        loss_pct = (100 * loss) / decision["state"]["pot"] if decision["state"]["pot"] > 0 else 0
    e = C["epsilon"]
    lp = 0 if loss_pct is None else loss_pct  # JS coerces null to 0 in comparisons
    if freq >= max_freq - C["bestWithin"] - e:
        grade, points = "best", C["points"]["best"]
    elif freq >= C["correctMinFreq"] - e:
        grade, points = "correct", C["correctBase"] + (C["correctSpan"] * freq) / max_freq
    elif not is_chart and loss_pct is not None and loss_pct <= C["correctMaxLossPct"] + e:
        grade, points = "correct", C["correctBase"] + (C["correctSpan"] * freq) / max_freq
    elif (freq > 0) if is_chart else (lp < C["inaccuracyMaxLossPct"]):
        grade, points = "inaccuracy", C["points"]["inaccuracy"]
    elif True if is_chart else (lp < C["wrongMaxLossPct"]):
        grade, points = "wrong", C["points"]["wrong"]
    else:
        grade, points = "blunder", C["points"]["blunder"]
    return {"grade": grade, "label": GRADE_LABELS[grade], "points": round2(points), "freq": freq, "maxFreq": max_freq,
            "loss": None if loss is None else round2(loss), "lossPct": None if loss_pct is None else round2(loss_pct)}


# ---------------------------------------------------------------------------
# ---- range grids

GRID_RANKS = "AKQJT98765432"


def class_name(idx):
    i, j = divmod(idx, 13)
    if i == j:
        return GRID_RANKS[i] * 2
    if i < j:
        return GRID_RANKS[i] + GRID_RANKS[j] + "s"
    return GRID_RANKS[j] + GRID_RANKS[i] + "o"


def class_combos(idx):
    i, j = divmod(idx, 13)
    return 6 if i == j else (4 if i < j else 12)


def class_index(name):
    a, b = GRID_RANKS.index(name[0]), GRID_RANKS.index(name[1])
    if a == b:
        return 13 * a + a
    if name[2] == "s":
        return 13 * a + b
    return 13 * b + a


def top_by_option(rng, k, n=8):
    rows = []
    for c in range(169):
        w = rng["w"][c]
        f = rng["f"][c][k] if rng.get("f") else 0
        combos = w * class_combos(c) * f
        if combos >= 0.005:  # below that it would print as 0.0 combos
            rows.append((combos, class_name(c), f))
    rows.sort(key=lambda r: (-r[0], r[1]))
    return [{"class": nm, "combos": round(cb, 2), "freq": round(f * 100, 1)} for cb, nm, f in rows[:n]]


def heaviest(w, n=10):
    rows = [(w[c] * class_combos(c), class_name(c), w[c]) for c in range(169) if w[c] > 0]
    rows.sort(key=lambda r: (-r[0], r[1]))
    return [{"class": nm, "combos": round(cb, 2), "weightPct": round(ww * 100, 1)} for cb, nm, ww in rows[:n]]


# ---------------------------------------------------------------------------
# ---- hand types of whole ranges (exact per combo)

HAND_TYPES = ["straight or better", "set or trips", "two pair", "overpair",
              "top pair, good kicker", "top pair, weak kicker", "middle or bottom pair, underpair",
              "strong draw", "weak draw", "nothing"]
MADE_TYPES = HAND_TYPES[:7]
DRAW_TYPES = ["strong draw", "weak draw"]


def class_cards(idx):
    """All 2-card combos (parsed) of a grid class: 6 pairs, 4 suited, 12 offsuit."""
    i, j = divmod(idx, 13)
    r1, r2 = RANK_VAL[GRID_RANKS[i]], RANK_VAL[GRID_RANKS[j]]
    if i == j:
        return [((r1, a), (r1, b)) for a, b in itertools.combinations(SUITS, 2)]
    if i < j:
        return [((r1, s), (r2, s)) for s in SUITS]
    hi, lo = r2, r1  # offsuit: row j holds the higher rank
    return [((hi, a), (lo, b)) for a in SUITS for b in SUITS if a != b]


def good_kickers(board):
    """Top pair kicker rule: a kicker is 'good' when it is one of the three highest
    ranks that are not on the board."""
    br = {c[0] for c in board}
    return [r for r in range(14, 1, -1) if r not in br][:3]


def _strong_draw(hole, board, cat):
    """Flush draw (4 to a flush with a hole card) or an 8-out straight draw."""
    if len(board) >= 5:
        return False
    if cat < FLUSH:
        for s in SUITS:
            hs = sum(1 for c in hole if c[1] == s)
            if hs and hs + sum(1 for c in board if c[1] == s) == 4:
                return True
    if cat < STRAIGHT and not hero_has_straight(hole, board):
        if len(straight_completers(hole, board)) >= 2:
            return True
    return False


def hand_type(hole, board, board_info=None):
    """Hand type of one two-card combo on this board (one of HAND_TYPES) and
    whether it also has a strong draw (flush draw or 8-out straight draw)."""
    if board_info is None:
        board_info = _board_info(board)
    allc = list(hole) + list(board)
    v = fast_value(allc)
    cat = v[0]
    hr = [c[0] for c in hole]
    br = board_info["ranks"]
    bmax = board_info["max"]
    sd = _strong_draw(hole, board, cat)
    if len(board) >= 5:
        hole_counts = v > board_info["value"]
    else:
        hole_counts = cat > board_info["value"][0]
    if cat >= STRAIGHT and hole_counts:
        return "straight or better", sd
    if cat == TRIPS and v[1] in hr and hole_counts:
        return "set or trips", sd
    pocket = hr[0] == hr[1]
    if pocket and hr[0] in br:  # set that is part of a bigger hand on the board
        return "set or trips", sd
    paired = sorted({r for r in hr if r in br}, reverse=True)
    if len(paired) == 2:
        return "two pair", sd
    if pocket and hr[0] > bmax:
        return "overpair", sd
    if paired:
        r = paired[0]
        if r == bmax:
            kick = [x for x in hr if x != r]
            if kick and kick[0] in board_info["goodKickers"]:
                return "top pair, good kicker", sd
            return "top pair, weak kicker", sd
        return "middle or bottom pair, underpair", sd
    if pocket:
        return "middle or bottom pair, underpair", sd
    if len(board) >= 5:
        return "nothing", False
    if sd:
        return "strong draw", True
    if cat < STRAIGHT and not hero_has_straight(hole, board) and straight_completers(hole, board):
        return "weak draw", False
    if any(r > bmax for r in hr):
        return "weak draw", False
    if len(board) == 3:
        for s in SUITS:
            hs = sum(1 for c in hole if c[1] == s)
            if hs and hs + sum(1 for c in board if c[1] == s) == 3:
                return "weak draw", False
        if backdoor_straight_windows(hole, board):
            return "weak draw", False
    return "nothing", False


def _board_info(board):
    br = {c[0] for c in board}
    val = eval5(board) if len(board) == 5 else eval_partial(board)
    return {"ranks": br, "max": max(br), "value": val, "goodKickers": good_kickers(board)}


_TYPE_CACHE = {}


def board_types(board):
    """Hand type of every combo that does not use a board card. Cached per board."""
    key = tuple(sorted(board))
    if key in _TYPE_CACHE:
        return _TYPE_CACHE[key]
    info = _board_info(board)
    bset = set(board)
    out = {}
    for idx in range(169):
        for combo in class_cards(idx):
            if combo[0] in bset or combo[1] in bset:
                continue
            out[combo] = hand_type(combo, board, info)
    if len(_TYPE_CACHE) > 64:
        _TYPE_CACHE.clear()
    _TYPE_CACHE[key] = out
    return out


def range_by_type(w, f, board, exclude=(), n_opts=0):
    """Split a range grid into hand types.
    w: 169 class weights; f: 169 lists of option frequencies (or None).
    Each live combo of a class (not using a board card) gets weight w*n/n_live,
    the class average: the grid does not say how reach differs between the
    suits of one class. Combos using a card in `exclude` are dropped (card
    removal of hero's own cards from villain's range).
    Returns {total, types: {type: {"w", "opt": [..], "strongDraw"}}}."""
    types = board_types(board)
    excl = set(exclude)
    bset = set(board)
    res = {t: {"w": 0.0, "opt": [0.0] * n_opts, "strongDraw": 0.0} for t in HAND_TYPES}
    total = 0.0
    for idx in range(169):
        wc = w[idx]
        if wc <= 0:
            continue
        combos = class_cards(idx)
        live = [c for c in combos if c[0] not in bset and c[1] not in bset]
        if not live:
            continue
        per = wc * len(combos) / len(live)
        for c in live:
            if c[0] in excl or c[1] in excl:
                continue
            t, sd = types[c]
            r = res[t]
            r["w"] += per
            total += per
            if sd:
                r["strongDraw"] += per
            if n_opts and f:
                for k in range(n_opts):
                    r["opt"][k] += per * f[idx][k]
    return {"total": total, "types": res}


def _p(x, tot):
    return round(100 * x / tot, 1) if tot > 0 else 0.0


def summarize_types(rt, labels=None):
    """JSON-friendly summary: share of each type; per type the option split;
    per option the type composition."""
    tot = rt["total"]
    rows = []
    for t in HAND_TYPES:
        r = rt["types"][t]
        if r["w"] <= 0:
            continue
        row = {"type": t, "pct": _p(r["w"], tot), "combos": round(r["w"], 2)}
        if r["strongDraw"] > 0 and t in MADE_TYPES:
            row["withStrongDrawPct"] = _p(r["strongDraw"], r["w"])
        if labels:
            row["split"] = {lab: _p(r["opt"][k], r["w"]) for k, lab in enumerate(labels)}
        rows.append(row)
    out = {"combos": round(tot, 2), "types": rows}
    if labels:
        comp = {}
        out["optionCombos"] = {}
        for k, lab in enumerate(labels):
            ok = sum(rt["types"][t]["opt"][k] for t in HAND_TYPES)
            out["optionCombos"][lab] = round(ok, 2)
            comp[lab] = [{"type": t, "pct": _p(rt["types"][t]["opt"][k], ok)}
                         for t in HAND_TYPES if ok > 0 and rt["types"][t]["opt"][k] > 0 and _p(rt["types"][t]["opt"][k], ok) > 0]
        out["optionMakeup"] = comp
    return out


def versus_type(hero_type, villain_rt):
    """Rough ordering of villain's range against hero's hand type."""
    tot = villain_rt["total"]
    hi = HAND_TYPES.index(hero_type)
    stronger = same = weaker_made = draws_ = nothing = 0.0
    for i, t in enumerate(HAND_TYPES):
        x = villain_rt["types"][t]["w"]
        if t == "nothing":
            nothing += x
        elif i < hi:
            stronger += x
        elif i == hi:
            same += x
        elif t in DRAW_TYPES:
            draws_ += x
        else:
            weaker_made += x
    return {"strongerTypePct": _p(stronger, tot), "sameTypePct": _p(same, tot),
            "weakerMadePct": _p(weaker_made, tot), "drawsPct": _p(draws_, tot), "nothingPct": _p(nothing, tot)}


# ---- blockers

def blockers(hole, board):
    """Card-removal facts from hero's two cards (computed from the cards only)."""
    facts = []
    n = len(board)
    for s in SUITS:
        nb = sum(1 for c in board if c[1] == s)
        if nb < 2 or (nb == 2 and n == 5):
            continue
        top = next((r for r in range(14, 1, -1) if (r, s) not in set(board)), None)
        mine = sorted([c for c in hole if c[1] == s], key=lambda c: -c[0])
        if top and (top, s) in set(hole):
            what = "the nut flush" if nb >= 3 else "the nut flush draw"
            facts.append(f"you hold the {cstr((top, s))}, the highest {SUIT_ONE[s]} not on the board: villain cannot have {what}")
        elif mine and nb >= 3:
            facts.append(f"you hold {len(mine)} {SUIT_NAME[s] if len(mine) > 1 else SUIT_ONE[s]} ({card_names(mine)}): "
                         f"fewer {SUIT_ONE[s]} flush combos for villain")
    counts = {}
    for c in board:
        counts[c[0]] = counts.get(c[0], 0) + 1
    top_rank = max(counts)
    for r in sorted(counts, reverse=True):
        mine = [c for c in hole if c[0] == r]
        if not mine:
            continue
        left = 4 - counts[r] - len(mine)
        if counts[r] >= 2:
            facts.append(f"you hold {_a(r) if len(mine) == 1 else 'two ' + PLURAL[r]} of the paired board rank: "
                         f"villain has fewer trips ({left} {NAME[r] if left == 1 else PLURAL[r]} left unseen)")
        elif r == top_rank:
            facts.append(f"you hold {_a(r) if len(mine) == 1 else 'two ' + PLURAL[r]} of the top board rank: "
                         f"villain has fewer top pairs ({left} {NAME[r] if left == 1 else PLURAL[r]} left unseen)")
    base, singles, pairs = straight_combos(board)
    hr = {c[0] for c in hole}
    bl_single = [r for r in singles if r in hr]
    if bl_single:
        facts.append("you hold " + " and ".join(_a(r) for r in sorted(bl_single, reverse=True))
                     + ", a card that alone makes a straight on this board: villain has fewer straights")
    elif pairs:
        touched = [(a, b) for a, b in pairs if a in hr or b in hr]
        if touched:
            mine = sorted({x for ab in touched for x in ab if x in hr}, reverse=True)
            facts.append("you hold " + " and ".join(_a(r) for r in mine)
                         + ": a card of the two-card straights " + ", ".join(VAL_CHAR[a] + VAL_CHAR[b] for a, b in touched)
                         + ", so villain has fewer of them")
    return facts or ["no relevant blockers"]


def _a(r):
    return ("an " if r in (14, 8) else "a ") + NAME[r]


def spr_band(spr):
    if spr is None:
        return None
    if spr > 6:
        return "deep (SPR above 6)"
    if spr >= 3:
        return "medium (SPR 3 to 6)"
    return "shallow (SPR below 3)"


# ---------------------------------------------------------------------------
# ---- fact sheet

def pct(x):
    return None if x is None else round(x * 100, 1)


def verdict(opts):
    """clear: the best-EV option has frequency >= 70% AND every other option loses
    >= 1.5% of the pot. close: the top two options by EV are within 0.5% of the
    pot. lean: everything else. (The two rules cannot both hold.)"""
    by_ev = sorted(opts, key=lambda o: (-o["ev"], -o["freq"]))
    best, second = by_ev[0], by_ev[1]
    if best["freq"] >= 0.70 - 1e-9 and all(o["lossPctRaw"] >= 1.5 for o in by_ev[1:]):
        return "clear"
    if second["lossPctRaw"] <= 0.5 + 1e-9:
        return "close"
    return "lean"


def loss_pct_display(x):
    """EV loss in % of the pot as printed: two decimals below 1%, one above, and
    more digits when rounding would land exactly on a grade boundary (0.2, 1.5,
    6) that the true value is not on, so the sheet never seems to contradict the grade."""
    dec = 2 if x < 1 else 1
    for b in (GRADING["correctMaxLossPct"], GRADING["inaccuracyMaxLossPct"], GRADING["wrongMaxLossPct"]):
        while dec < 4 and round(x, dec) == b and abs(x - b) > 1e-9:
            dec += 1
    return round(x, dec)


def fmt_bb(x):
    return f"{x:.2f}"


def build_facts(sol):
    hero_cards = sol["hero"]["hand"]
    steps = sol["steps"]
    preflop_line = []
    for s in steps:
        if s.get("street") != "preflop":
            continue
        if s["type"] == "action":
            preflop_line.append(f"{s['seat']} {s['kind']}" + (f" {s['amount']:g}" if s.get("amount") is not None else ""))
        elif s["type"] == "decision":
            opt = next(o for o in s["options"] if o["id"] == s["mainLine"])
            preflop_line.append(f"{sol['hero']['seat']} (hero) {opt['label']}")
    b = sol["board"]
    final_board = list(b.get("flop") or []) + ([b["turn"]] if b.get("turn") else []) + ([b["river"]] if b.get("river") else [])
    sv = sol.get("solver") or {}
    acc = []
    if sv.get("iterations") is not None:
        acc.append(f"{sv['iterations']} iterations")
    if sv.get("exploitabilityPctPot") is not None:
        acc.append(f"exploitability {sv['exploitabilityPctPot']}% of the pot"
                   + (f" (target {sv['targetPctPot']}%)" if sv.get("targetPctPot") is not None else ""))
    if sv.get("seconds") is not None:
        acc.append(f"{sv['seconds']} s")
    facts = {
        "id": sol["id"], "title": sol.get("title"), "tags": sol.get("tags", []),
        "scenario": sol.get("scenario"), "hero": sol["hero"], "villain": sol["villain"],
        "startingStackBb": sol.get("startingStackBb"),
        "preflopLine": preflop_line, "board": {"flop": b.get("flop"), "turn": b.get("turn"), "river": b.get("river"), "final": final_board},
        "solverAccuracy": {**sv, "text": ", ".join(acc)}, "warnings": sol.get("warnings", []),
        "decisions": [], "afterLastDecision": [], "result": None,
    }
    board_so_far = []
    prev_decision_board = None
    events = []
    aggr = {}  # street -> last bet/raise on that street so far
    hero_seat = sol["hero"]["seat"]
    hero_parsed = [parse(c) for c in hero_cards]
    for s in steps:
        t = s["type"]
        if t == "action" and s.get("kind") in ("raise", "bet", "allin"):
            aggr[s["street"]] = {"who": "hero" if s["seat"] == hero_seat else "villain", "seat": s["seat"],
                                 "action": f"{s['kind']} {s['amount']:g}" if s.get("amount") is not None else s["kind"]}
        elif t == "villain" and s["action"]["kind"] in ("raise", "bet", "allin"):
            aggr[s["street"]] = {"who": "villain", "seat": s["seat"], "action": s["action"]["label"]}
        if t == "deal":
            board_so_far = board_so_far + list(s["cards"])
            events.append({"type": "deal", "street": s["street"], "cards": s["cards"], "pot": s["state"]["pot"],
                           "text": f"{s['street'].upper()} dealt: {' '.join(s['cards'])} (board {' '.join(board_so_far)}; pot {s['state']['pot']:g})"})
        elif t == "action" and s.get("street") != "preflop":
            events.append({"type": "forced", "street": s["street"], "seat": s["seat"], "kind": s["kind"],
                           "text": f"{s['seat']} {s['kind']} (forced: the only legal option)"})
        elif t == "villain":
            k = [o["id"] for o in s["options"]].index(s["action"]["id"])
            alts = [{"label": o["label"], "freqPct": pct(s["range"]["freq"][i])} for i, o in enumerate(s["options"]) if i != k]
            ev = {"type": "villain", "street": s["street"], "seat": s["seat"], "action": s["action"]["label"],
                  "freqPct": pct(s["freq"]), "alternatives": alts, "rangeCombos": s["range"].get("combos"),
                  "topClassesTakingThisAction": top_by_option(s["range"], k, 8),
                  "potAfter": s["state"]["pot"]}
            if len(board_so_far) >= 3:
                ev["handTypes"] = villain_action_types(s, k, board_so_far, hero_parsed)
                j = main_alternative(s, k)
                if j is not None:
                    ev["alternativeHandTypes"] = villain_action_types(s, j, board_so_far, hero_parsed)
            ev["text"] = (f"Villain {s['seat']}: {s['action']['label']} ({ev['freqPct']}% of villain's range; "
                          + ", ".join(f"{a['label']} {a['freqPct']}%" for a in alts) + f") [range {s['range'].get('combos')} combos]")
            events.append(ev)
        elif t == "decision":
            cur = aggr.get(s["street"])
            facing = bool(cur and cur["who"] == "villain")
            d = decision_facts(sol, s, list(board_so_far), prev_decision_board, hero_cards, facing)
            d["strategic"] = strategic_facts(sol, s, list(board_so_far), d, dict(aggr))
            ml = next(o for o in s["options"] if o["id"] == s["mainLine"])
            if ml["kind"] in ("raise", "bet", "allin"):
                aggr[s["street"]] = {"who": "hero", "seat": hero_seat, "action": ml["label"]}
            d["eventsSinceLastDecision"] = events
            events = []
            facts["decisions"].append(d)
            prev_decision_board = list(board_so_far)
        elif t == "end":
            res = {"reason": s["reason"], "heroNet": s.get("heroNet"), "finalPot": s["state"]["pot"]}
            sd = s.get("showdown")
            if sd:
                res["showdown"] = sd
                if len(final_board) == 5:
                    hv = value_of([parse(c) for c in hero_cards + final_board])
                    vv = value_of([parse(c) for c in sd["villainHand"] + final_board])
                    res["computed"] = {"heroCategory": CAT_NAME[hv[0]], "villainCategory": CAT_NAME[vv[0]],
                                       "winner": "hero" if hv > vv else ("villain" if vv > hv else "split")}
            facts["result"] = res
    facts["afterLastDecision"] = events
    return facts


STREETS = ["preflop", "flop", "turn", "river"]


def villain_action_types(step, k, board, hero_parsed):
    """What kinds of hands villain takes option k with (hero's cards removed)."""
    rng = step["range"]
    n = len(step["options"])
    rt = range_by_type(rng["w"], rng["f"], [parse(c) for c in board], exclude=hero_parsed, n_opts=n)
    ok = sum(rt["types"][t]["opt"][k] for t in HAND_TYPES)
    rows = []
    for t in HAND_TYPES:
        r = rt["types"][t]
        if r["opt"][k] <= 0 or _p(r["opt"][k], ok) <= 0:
            continue
        rows.append({"type": t, "pctOfAction": _p(r["opt"][k], ok), "takesItPct": _p(r["opt"][k], r["w"])})
    return {"action": step["options"][k]["label"], "actionPctOfRange": pct(rng["freq"][k]),
            "combos": round(ok, 2), "types": rows}


def main_alternative(step, k):
    """Index of villain's most frequent alternative to the action taken, if it is a
    bet or raise taken at least 20% of the time; else None."""
    freqs = step["range"]["freq"]
    alts = [i for i in range(len(step["options"])) if i != k]
    if not alts:
        return None
    j = max(alts, key=lambda i: freqs[i])
    if step["options"][j]["kind"] in ("bet", "raise", "allin") and freqs[j] >= 0.20 - 1e-9:
        return j
    return None


def strategic_facts(sol, s, board, d, aggr):
    """Position, initiative, SPR band, blockers and hand-type breakdowns."""
    street = s["street"]
    hero_pos = sol["hero"]["position"]
    ip = hero_pos == "ip"
    out = {}
    if street == "preflop":
        pos = (f"preflop chart decision; after the flop hero is {'in position (acts last)' if ip else 'out of position (acts first)'}")
    else:
        pos = (f"hero is in position: villain acts first and hero acts last on the {street}" if ip
               else f"hero is out of position: hero acts first and villain acts last on the {street}")
    out["position"] = {"heroInPosition": ip, "text": pos}
    si = STREETS.index(street)
    init = []
    if si > 0:
        prev = STREETS[si - 1]
        a = aggr.get(prev)
        if a:
            init.append(f"last bet or raise on the {prev}: {a['who']} ({a['seat']} {a['action']})")
        else:
            init.append(f"nobody bet the {prev} (checked through)")
        out["previousStreetAggressor"] = a["who"] if a else None
    cur = aggr.get(street)
    if cur:
        init.append(f"on this street so far: {cur['who']} ({cur['seat']} {cur['action']})")
    elif street != "preflop":
        init.append("no bet yet on this street")
    out["initiative"] = "; ".join(init)
    out["sprBand"] = spr_band(d["situation"]["spr"])
    if street == "preflop" or len(board) < 3:
        return out
    bp = [parse(c) for c in board]
    hole = [parse(c) for c in sol["hero"]["hand"]]
    out["blockers"] = blockers(hole, bp)
    labels = [o["label"] for o in s["options"]]
    rng = s["range"]
    hero_rt = range_by_type(rng["w"], rng["f"], bp, n_opts=len(labels))
    out["heroRangeTypes"] = summarize_types(hero_rt, labels)
    ht, hsd = hand_type(tuple(hole), bp)
    r = hero_rt["types"][ht]
    out["heroHandType"] = {"type": ht, "withStrongDraw": hsd,
                           "groupPctOfRange": _p(r["w"], hero_rt["total"]),
                           "groupSplit": {lab: _p(r["opt"][k], r["w"]) for k, lab in enumerate(labels)} if r["w"] > 0 else None}
    vr = s.get("villainRange")
    if vr:
        v_rt = range_by_type(vr["w"], None, bp, exclude=hole)
        out["villainRangeTypes"] = summarize_types(v_rt)
        out["villainVsHeroType"] = versus_type(ht, v_rt)
    return out


def decision_facts(sol, s, board, prev_decision_board, hero_cards, facing=None):
    st = s["state"]
    pot = st["pot"]
    to_call = s.get("toCall", 0) or 0
    eff = min(st["heroStack"], st["villainStack"])
    sit = {"street": s["street"], "board": board, "pot": pot, "toCall": to_call,
           "heroStack": st["heroStack"], "villainStack": st["villainStack"],
           "heroBetThisStreet": st.get("heroBet"), "villainBetThisStreet": st.get("villainBet"),
           "spr": round(eff / pot, 2) if pot > 0 else None}
    if to_call > 0:
        if facing is None or facing:
            sit["price"] = f"call {to_call:g} to win {pot:g}"
            sit["equityNeededPct"] = round(100 * to_call / (pot + to_call), 1)
        sit["facingBetOrRaise"] = bool(facing) if facing is not None else True
    out = {"index": s["index"], "street": s["street"], "source": s["source"], "chart": s.get("chart"),
           "situation": sit}
    # hero hand from the cards; the new card is judged against the board at
    # the end of the previous street
    prev_street_board = None
    if len(board) == 4:
        prev_street_board = board[:3]
    elif len(board) == 5:
        prev_street_board = board[:4]
    out["heroHand"] = hand_facts(hero_cards, board, prev_street_board)
    # solver numbers
    opts = []
    hand = s["hand"]
    evs = hand.get("ev")
    best_ev = max(evs) if isinstance(evs, list) else None
    for i, o in enumerate(s["options"]):
        g = grade_decision(s, o["id"])
        row = {"id": o["id"], "label": o["label"], "freq": hand["freq"][i], "freqPct": pct(hand["freq"][i]),
               "grade": g["label"], "points": g["points"], "mainLine": o["id"] == s["mainLine"],
               "rangeFreqPct": pct(s["range"]["freq"][i]) if s.get("range") else None}
        if best_ev is not None:
            loss = max(0, best_ev - evs[i])
            row.update({"ev": evs[i], "evLossBb": round2(loss),
                        "evLossPctPot": loss_pct_display(100 * loss / pot) if pot > 0 else 0.0,
                        "lossPctRaw": (100 * loss / pot) if pot > 0 else 0.0})
        opts.append(row)
    sol_part = {"options": opts}
    if s["source"] == "chart" or best_ev is None:
        sol_part["note"] = "preflop chart decision: frequencies only, no EV and no equity"
        top = max(opts, key=lambda o: o["freq"])
        sol_part["mostFrequent"] = top["label"]
        sol_part["verdict"] = None
    else:
        by_ev = sorted(opts, key=lambda o: (-o["ev"], -o["freq"]))
        gap = by_ev[0]["ev"] - by_ev[1]["ev"]
        sol_part.update({
            "bestByEv": by_ev[0]["label"], "secondByEv": by_ev[1]["label"],
            "gapBestSecondBb": round2(gap), "gapBestSecondPctPot": loss_pct_display(100 * gap / pot) if pot > 0 else 0.0,
            "mostFrequent": max(opts, key=lambda o: o["freq"])["label"],
            "handEquityPct": pct(hand.get("equity")),
            "rangeEquityPct": pct(s["range"].get("equity")),
            "villainRangeEquityPct": pct((s.get("villainRange") or {}).get("equity")),
            "verdict": verdict(opts)})
        for o in opts:
            o.pop("lossPctRaw", None)
    out["solver"] = sol_part
    # whole-range facts
    rng = s["range"]
    rf = {"heroRangeCombos": rng.get("combos"),
          "heroRangeSplit": [{"label": o["label"], "pct": pct(rng["freq"][i])} for i, o in enumerate(s["options"])],
          "heroTopClassesByOption": {o["label"]: top_by_option(rng, i, 8) for i, o in enumerate(s["options"])}}
    hc = sol["hero"].get("handClass")
    if hc:
        ci = class_index(hc)
        rf["heroClassInRange"] = {"class": hc, "weightPct": pct(rng["w"][ci]),
                                  "freqPctByOption": {o["label"]: pct(rng["f"][ci][i]) for i, o in enumerate(s["options"])}}
    vr = s.get("villainRange")
    if vr:
        rf["villainRangeCombos"] = vr.get("combos")
        rf["villainTopClasses"] = heaviest(vr["w"], 10)
    else:
        rf["villainTopClasses"] = None
        rf["villainNote"] = "no villain range in the file at a preflop chart decision"
    out["ranges"] = rf
    return out


# ---------------------------------------------------------------------------
# ---- text layout

TXT_HEADER = """HOW TO READ THIS FILE
- All money is in big blinds (bb). "pot" is everything in the middle, including
  bets already made on this street. Price when facing a bet: "call X to win Y"
  where Y is that pot; equity needed = X / (Y + X).
- SPR = the smaller stack behind / pot.
- Hero's hand, draws, outs and board texture are computed from the cards only.
  Outs can be dirty: the tool does not know villain's cards; an out may also
  improve villain or still lose. Each unseen card is counted in one bucket only.
  "straight or better" = the card gives hero a straight, flush, full house,
  quads or straight flush that the board alone does not give everyone.
  Backdoor draws are listed on the flop only; a backdoor straight draw is
  listed only when there is no regular straight draw. River: no draws.
- Solver numbers are for hero's exact two cards. EV loss = best EV - this EV;
  % of pot uses the pot above. Grades and points are what the site awards.
  An option losing at most 0.2% of the pot is graded at least Correct.
  "<- main line" marks the option the hand continues with (normally the most
  frequent one); grades follow frequency first, so "Best by EV" can name a
  different option than the main line or the Best grade: that is how the site
  grades, not an error.
  Verdict rule: "clear" = best-EV option played >= 70% and every other option
  loses >= 1.5% of the pot; "close" = top two options within 0.5% of the pot
  in EV; "lean" = everything else.
- Range sections: hand classes like AKs (suited, 4 combos), AKo (offsuit, 12),
  QQ (pair, 6). "combos" = how many combos of that class are in the range,
  weighted by how often they get there; "freq" = how often that class takes
  the option. Hero's range split = share of hero's whole range taking each
  option. Villain's heaviest classes = the classes with the most combos in
  villain's range at that moment (cards in hero's hand are not removed).
- Hand types: every combo of a range is put in one type, strongest first:
  straight or better; set or trips; two pair (both hole cards pair the board);
  overpair; top pair, good kicker (kicker is one of the three highest ranks not
  on the board) or weak kicker; middle or bottom pair, underpair; strong draw
  (flush draw or 8-out straight draw, no pair); weak draw (gutshot, overcard,
  or on the flop a backdoor draw, no pair); nothing. A hand that only uses the
  board's pair counts as no pair. Computed exactly per suit combination against
  the board (combos that use a board card are not counted; in villain's range
  hero's two cards are removed too). Approximation: the range grid gives one
  weight and one option split per hand class, so every combo of a class gets
  the class average (e.g. the flush-draw suits of 98s are assumed to play like
  its other suits). "Against your hand type" orders villain's range by type
  only; the exact number is the equity line.
- Position: postflop the player in position acts last on every street.
  Stack depth: deep = SPR above 6, medium = 3 to 6, shallow = below 3.
"""


def villain_type_lines(e):
    """The hand-type lines under a villain event: the action taken and, when it
    qualifies, villain's main alternative bet or raise."""
    out = []
    if e["type"] != "villain":
        return out
    if e.get("handTypes") and e["handTypes"]["types"]:
        ht = e["handTypes"]
        out.append(f"    villain hand types taking this action: {ht['action'].upper()} (the action villain took, "
                   f"{ht['actionPctOfRange']}% of his range) is made of " + ", ".join(
                       f"{x['type']} {x['pctOfAction']}% (takes it {x['takesItPct']}% of the time)" for x in ht["types"]))
    if e.get("alternativeHandTypes") and e["alternativeHandTypes"]["types"]:
        ht = e["alternativeHandTypes"]
        out.append(f"    villain hand types that would {ht['action'].upper()} here (the alternative villain did NOT take, "
                   f"{ht['actionPctOfRange']}% of his range): " + ", ".join(
                       f"{x['type']} {x['pctOfAction']}% (takes it {x['takesItPct']}% of the time)" for x in ht["types"]))
    return out


def to_text(f):
    L = []
    w = L.append
    sc = f.get("scenario") or {}
    w(f"{f['id']} - {f.get('title')}")
    w(f"Scenario: {sc.get('name')} ({sc.get('potType')}, key {sc.get('key')})")
    h, v = f["hero"], f["villain"]
    w(f"Hero: {h['seat']} ({h['position']}) {' '.join(h['hand'])} [{h.get('handClass')}]   Villain: {v['seat']} ({v['position']})")
    w(f"Preflop: {', '.join(f['preflopLine'])}")
    w(f"Final board: {' '.join(f['board']['final'])}")
    w(f"Solver accuracy: {f['solverAccuracy']['text']}")
    if f.get("warnings"):
        w(f"Warnings: {f['warnings']}")
    w("")
    w(TXT_HEADER)
    for d in f["decisions"]:
        for e in d["eventsSinceLastDecision"]:
            w("  " + e["text"])
            if e["type"] == "villain" and e["topClassesTakingThisAction"]:
                w("    villain classes taking this action: " + ", ".join(
                    f"{x['class']} {x['combos']} ({x['freq']}%)" for x in e["topClassesTakingThisAction"]))
            for line in villain_type_lines(e):
                w(line)
        s = d["situation"]
        w("")
        w(f"=== DECISION #{d['index']} ({d['street']}, {d['source']}{', chart ' + d['chart'] if d.get('chart') else ''}) ===")
        w(f"Board: {' '.join(s['board']) or '(none)'}")
        line = f"Pot {s['pot']:g}, to call {s['toCall']:g}, hero {s['heroStack']:g} behind, villain {s['villainStack']:g} behind, SPR {s['spr']}"
        w(line)
        if s.get("price"):
            w(f"Price: {s['price']}; equity needed {s['equityNeededPct']}%")
        hh = d["heroHand"]
        if "preflop" in hh:
            w(f"Hero's hand: {hh['preflop']['description']}")
        else:
            m = hh["made"]
            w(f"Hero's hand: {m['description']}  [best five: {' '.join(m['bestFive'])}]")
            w(f"Draws: {hh['draws']['summary']}")
            if hh["draws"]["overcards"] and m["category"] != "high card":
                w(f"Overcards to the board: {', '.join(hh['draws']['overcards'])}")
            o = hh["outs"]
            if o:
                parts = []
                for key, lab in (("straightOrBetter", o["straightOrBetter"].get("label", "to a straight or better")), ("twoPairOrTrips", "to two pair / trips / set"),
                                 ("topPair", "to top pair"), ("otherPair", "to a lower pair")):
                    if o[key]["count"]:
                        parts.append(f"{lab}: {o[key]['count']} ({' '.join(o[key]['cards'])})")
                w(f"Outs (of {o['unseenCount']} unseen cards; may be dirty): " + ("; ".join(parts) if parts else "none"))
            w(f"Board: {hh['texture']['summary']}")
            if hh.get("newCard"):
                w(f"New card {hh['newCard']['card']}: {hh['newCard']['summary']}")
        so = d["solver"]
        w("Options (hero's exact hand):")
        for o in so["options"]:
            ml = "  <- main line" if o["mainLine"] else ""
            if "ev" in o:
                w(f"  {o['label']:<22} {o['freqPct']:5.1f}%  EV {fmt_bb(o['ev']):>7}  loss {fmt_bb(o['evLossBb'])} bb ({o['evLossPctPot']}% pot)  "
                  f"grade {o['grade']} {o['points']:g} pts  (range {o['rangeFreqPct']}%){ml}")
            else:
                w(f"  {o['label']:<22} {o['freqPct']:5.1f}%  grade {o['grade']} {o['points']:g} pts  (range {o['rangeFreqPct']}%){ml}")
        if so.get("note"):
            w(f"  {so['note']}; most frequent: {so['mostFrequent']}")
        else:
            w(f"  Best by EV: {so['bestByEv']}; second: {so['secondByEv']}; gap {fmt_bb(so['gapBestSecondBb'])} bb ({so['gapBestSecondPctPot']}% pot); most frequent: {so['mostFrequent']}")
            w(f"  Hand equity {so['handEquityPct']}%; range equity hero {so['rangeEquityPct']}% vs villain {so['villainRangeEquityPct']}%; verdict: {so['verdict']}")
        r = d["ranges"]
        w(f"Hero's range ({r['heroRangeCombos']} combos) splits: " + ", ".join(f"{x['label']} {x['pct']}%" for x in r["heroRangeSplit"]))
        for lab, rows in r["heroTopClassesByOption"].items():
            w(f"  {lab}: " + (", ".join(f"{x['class']} {x['combos']} ({x['freq']}%)" for x in rows) or "(no hands)"))
        if r.get("heroClassInRange"):
            hc = r["heroClassInRange"]
            w(f"  Hero's class {hc['class']} as a whole: " + ", ".join(f"{k} {v}%" for k, v in hc["freqPctByOption"].items()))
        st = d.get("strategic") or {}
        if st:
            w(f"Position: {st['position']['text']}; initiative: {st['initiative']}"
              + (f"; stack depth: {st['sprBand']}" if st.get("sprBand") else ""))
        if st.get("blockers"):
            w("Blockers: " + "; ".join(st["blockers"]))
        if st.get("heroRangeTypes"):
            hrt = st["heroRangeTypes"]
            w(f"Hand types in hero's range ({hrt['combos']} combos):")
            for row in hrt["types"]:
                extra = f" (of which {row['withStrongDrawPct']}% also with a strong draw)" if row.get("withStrongDrawPct") else ""
                w(f"  {row['type']} {row['pct']}%{extra}: " + ", ".join(f"{k} {v}%" for k, v in row["split"].items()))
            w("Each option by hand type:")
            for lab, comp in hrt["optionMakeup"].items():
                w(f"  {lab} ({hrt['optionCombos'][lab]} combos): " + (", ".join(f"{x['type']} {x['pct']}%" for x in comp) or "(no hands)"))
            hht = st["heroHandType"]
            w(f"Your hand type: {hht['type']}" + (" (with a strong draw)" if hht["withStrongDraw"] else "")
              + f"; that type is {hht['groupPctOfRange']}% of hero's range and plays: "
              + (", ".join(f"{k} {v}%" for k, v in hht["groupSplit"].items()) if hht["groupSplit"] else "(not in the range grid)"))
        if st.get("villainRangeTypes"):
            vrt = st["villainRangeTypes"]
            w(f"Hand types in villain's range ({vrt['combos']} combos, your cards removed): "
              + ", ".join(f"{x['type']} {x['pct']}%" for x in vrt["types"]))
            vv = st["villainVsHeroType"]
            w(f"Against your hand type (approximate, by hand type; the exact number is the equity line): "
              f"stronger types {vv['strongerTypePct']}%, same type {vv['sameTypePct']}%, weaker made hands {vv['weakerMadePct']}%, "
              f"draws {vv['drawsPct']}%, nothing {vv['nothingPct']}% of villain's range")
        if r.get("villainTopClasses"):
            w(f"Villain's range ({r['villainRangeCombos']} combos), heaviest classes: " + ", ".join(
                f"{x['class']} {x['combos']}" for x in r["villainTopClasses"]))
        else:
            w(f"Villain's range: {r.get('villainNote')}")
    if f["afterLastDecision"]:
        w("")
        w("After the last decision:")
        for e in f["afterLastDecision"]:
            w("  " + e["text"])
            for line in villain_type_lines(e):
                w(line)
    res = f.get("result")
    if res:
        w("")
        line = f"RESULT: {res['reason']}, pot {res['finalPot']:g}, hero net {res['heroNet']:+.2f} bb"
        sd = res.get("showdown")
        if sd:
            line += (f"; villain shows {' '.join(sd['villainHand'])} ({sd.get('villainHandName')}) vs hero "
                     f"{sd.get('heroHandName')}; winner {sd.get('winner')}")
        w(line)
        if res.get("computed"):
            c = res["computed"]
            w(f"  (computed from the cards: hero {c['heroCategory']}, villain {c['villainCategory']}, winner {c['winner']})")
    return "\n".join(L) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("solutions_dir")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default=None)
    a = ap.parse_args(argv)
    only = set(x.strip() for x in a.only.split(",")) if a.only else None
    os.makedirs(a.out, exist_ok=True)
    n = 0
    errors = 0
    for fn in sorted(os.listdir(a.solutions_dir)):
        if not fn.endswith(".json") or fn.endswith(".facts.json"):
            continue
        pid = fn[:-5]
        if only and pid not in only:
            continue
        try:
            with open(os.path.join(a.solutions_dir, fn)) as fh:
                sol = json.load(fh)
            if not isinstance(sol, dict) or "steps" not in sol:
                continue
            facts = build_facts(sol)
        except Exception as ex:  # report and keep going
            errors += 1
            print(f"ERROR {fn}: {type(ex).__name__}: {ex}", file=sys.stderr)
            continue
        with open(os.path.join(a.out, f"{pid}.facts.json"), "w") as fh:
            json.dump(facts, fh, indent=1)
        with open(os.path.join(a.out, f"{pid}.facts.txt"), "w") as fh:
            fh.write(to_text(facts))
        n += 1
    print(f"wrote {n} fact sheets to {a.out}" + (f"; {errors} errors" if errors else ""))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
