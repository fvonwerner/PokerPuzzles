#!/usr/bin/env python3
"""Tests for tools/hand-facts.py.  Run: python3 tools/test_hand_facts.py

Every card case below was worked out by hand. The last test recomputes the
grade of every option of every decision in 20 solution files with the Python
port and compares it with server/lib/grading.mjs run through node.
"""

import importlib.util
import json
import os
import subprocess
import sys
import unittest


def load(path):
    with open(path) as fh:
        return json.load(fh)


def find_solution(pid):
    """A solution file by id: the live set first, then the archived v1 set."""
    for d in ("data/solutions", "data/archive/v1/solutions"):
        path = os.path.join(ROOT, d, pid + ".json")
        if os.path.exists(path):
            return load(path)
    raise unittest.SkipTest(f"{pid}.json not found")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("hand_facts", os.path.join(HERE, "hand-facts.py"))
hf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hf)


def P(s):
    """'As 4s' -> ['As', '4s']"""
    return s.split()


def facts(hole, board, prev=None):
    return hf.hand_facts(P(hole), P(board), P(prev) if prev else None)


class Made(unittest.TestCase):
    def made(self, hole, board):
        return facts(hole, board)["made"]

    def check(self, hole, board, cat, *phrases):
        m = self.made(hole, board)
        self.assertEqual(m["category"], cat, m)
        for ph in phrases:
            self.assertIn(ph, m["description"], m)
        return m

    def test_ace_high_owner_case(self):
        self.check("As 4s", "Kc Qd 8h 3s", "high card", "no pair: ace-high")

    def test_no_pair_three_high(self):
        self.check("2c 3d", "Kh Qs 8d", "high card", "no pair: three-high")

    def test_top_pair_ace_kicker(self):
        m = self.check("Ah Kd", "Kc 7s 2h", "pair", "top pair, ace kicker")
        self.assertEqual(m["kicker"], "ace")

    def test_top_pair_jack_kicker(self):
        self.check("Kh Jd", "Kc 9s 4h", "pair", "top pair, jack kicker")

    def test_top_pair_king_kicker(self):
        self.check("Ad Kc", "As 9h 4d", "pair", "top pair, king kicker")

    def test_second_pair(self):
        self.check("Ah 9d", "Kc 9s 4h", "pair", "second pair, ace kicker")

    def test_bottom_pair_flop(self):
        self.check("As 4d", "Kc 9s 4h", "pair", "bottom pair (third pair), ace kicker")

    def test_third_pair_turn(self):
        self.check("Ad 6c", "Ks 9h 6d 4c", "pair", "third pair, ace kicker")

    def test_bottom_pair_turn(self):
        self.check("Ad 4s", "Ks 9h 6d 4c", "pair", "bottom pair (fourth pair)")

    def test_kicker_does_not_play_river(self):
        self.check("Kh 2d", "Kc Qs Jd 8h 7c", "pair", "top pair, two kicker", "kicker does not play")

    def test_overpair(self):
        self.check("Qs Qd", "Jh 7c 2d", "pair", "overpair (pocket queens)")

    def test_underpair_to_one(self):
        self.check("9s 9d", "Kh 7c 2d", "pair", "below the top card (underpair to one board card: K; above 7 2)")

    def test_underpair_to_two(self):
        self.check("9s 9d", "Kh Qc 2d", "pair", "underpair to two board cards: K Q")

    def test_underpair_below_every_card(self):
        self.check("4s 4d", "Kh Qc 9d", "pair", "below every board card (underpair to three board cards")

    def test_set(self):
        self.check("7c 7d", "Kh 7s 2c", "three of a kind", "set of sevens")

    def test_trips_kicker(self):
        m = self.check("Ks 9d", "Kh Kd 4c", "three of a kind", "trips, kings (one hole card + a pair on the board); kicker nine")
        self.assertEqual(m["kicker"], "nine")

    def test_trips_on_board(self):
        self.check("Ah Qd", "7c 7d 7s", "three of a kind", "on the board")

    def test_two_pair_both_hole_cards(self):
        self.check("Kh 8d", "Kc 8s 3h", "two pair", "kings and eights, with both hole cards")

    def test_two_pair_hole_plus_board_pair(self):
        self.check("Ah 5d", "Ac 9s 9d", "two pair", "aces (one hole card) and nines (board pair)", "your own pair is top pair")

    def test_two_pair_board_pair_bottom_own(self):
        self.check("Ah 8d", "Kc Ks 8h", "two pair", "kings (board pair) and eights (one hole card)", "your own pair is bottom pair")

    def test_two_pair_pocket_plus_board_pair(self):
        self.check("Jh Jd", "8c 8s 3h", "two pair", "jacks (pocket pair) and eights (board pair)", "an overpair")

    def test_two_pair_on_board(self):
        m = self.check("Ah 2d", "Kc Ks 7h 7d 9c", "two pair", "both pairs on the board", "kicker ace (yours)")
        self.assertFalse(m["playsTheBoard"])

    def test_plays_board_two_pair(self):
        m = self.check("Qd Jc", "Kc Ks 7h 7d Ac", "two pair", "you play the board")
        self.assertTrue(m["playsTheBoard"])
        self.assertEqual(m["holeCardsUsed"], [])

    def test_counterfeited_two_pair(self):
        m = self.check("7h 6h", "7c 6d 2s Kc Kd", "two pair", "counterfeited: your pair of sixes no longer plays")
        self.assertEqual(m["counterfeited"], "sixes")

    def test_counterfeited_pocket_pair(self):
        self.check("3c 3d", "Kh Ks 9c 9d 2s", "two pair", "counterfeited: your pair of threes")

    def test_not_counterfeited(self):
        m = self.made("Kh 8d", "Kc 8s 3h 2d")
        self.assertNotIn("counterfeited", m)

    def test_board_pair_no_own_pair(self):
        self.check("Ah Qd", "8c 8s 3h", "pair", "no pair of your own", "ace-high")

    def test_straight_one_hole_card_not_nut(self):
        m = self.check("Td 2c", "9c 8d 7h 6s", "straight", "straight, ten-high (using Td)", "not the nut straight (jack-high")
        self.assertFalse(m["nutStraight"])

    def test_nut_straight(self):
        m = self.check("Jd Tc", "9h 8s 7d", "straight", "jack-high", "the nut straight")
        self.assertTrue(m["nutStraight"])

    def test_wheel(self):
        self.check("Ah 2c", "3d 4s 5h", "straight", "five-high")

    def test_board_straight_plays_board(self):
        m = self.check("2c 3d", "9h 8s 7d 6c 5h", "straight", "you play the board", "nine-high")
        self.assertTrue(m["playsTheBoard"])

    def test_board_straight_improved(self):
        m = self.check("Tc 2d", "9h 8s 7d 6c 5h", "straight", "ten-high (using Tc)")
        self.assertFalse(m["playsTheBoard"])

    def test_board_flush_plays_board(self):
        m = self.check("Qd 3c", "2h 5h 8h Jh Kh", "flush", "you play the board", "entirely on the board")
        self.assertTrue(m["playsTheBoard"])

    def test_board_flush_nut_with_ace(self):
        m = self.check("Ah 3c", "2h 5h 8h Jh Kh", "flush", "one hole card, the Ah", "the nut flush")
        self.assertTrue(m["nutFlush"])

    def test_board_flush_small_card_improves(self):
        m = self.check("3h 2c", "2h 5h 8h Jh Kh", "flush", "one hole card, the 3h", "not the nut flush")
        self.assertFalse(m["playsTheBoard"])

    def test_flush_two_hole_cards_nut(self):
        self.check("Ah 9h", "Kh 7h 2h", "flush", "both hole cards", "the nut flush")

    def test_flush_two_hole_cards_not_nut(self):
        self.check("9h 8h", "Kh 7h 2h", "flush", "both hole cards", "not the nut flush (higher hearts unseen: A Q J T)")

    def test_full_house_set_board_pair(self):
        self.check("7c 7d", "7s Kh Kd", "full house", "sevens full of kings")

    def test_full_house_pocket_pair_board_trips(self):
        self.check("5c 5d", "7s 7h 7d", "full house", "sevens full of fives")

    def test_quads_pocket_pair(self):
        self.check("7c 7d", "7s 7h Kd", "four of a kind", "pocket pair + two board cards")

    def test_quads_one_hole_card(self):
        self.check("Ks 2d", "Kh Kd Kc", "four of a kind", "one hole card + three on the board")

    def test_straight_flush(self):
        self.check("9h 8h", "7h 6h 5h", "straight flush", "nine-high")


class Draws(unittest.TestCase):
    def d(self, hole, board):
        return facts(hole, board)["draws"]

    def test_owner_case_no_draws(self):
        d = self.d("As 4s", "Kc Qd 8h 3s")
        self.assertIsNone(d["flushDraw"])
        self.assertIsNone(d["straightDraw"])
        self.assertEqual(d["backdoorFlushDraws"], [])
        self.assertIsNone(d["backdoorStraightDraw"])
        self.assertEqual(d["overcards"], ["ace"])
        self.assertEqual(d["summary"], "one overcard (ace)")

    def test_owner_case_flop_no_backdoor(self):
        # As4s on Kc Qd 8h: only two spades -> no backdoor flush draw
        d = self.d("As 4s", "Kc Qd 8h")
        self.assertEqual(d["backdoorFlushDraws"], [])

    def test_backdoor_flush_two_hole_cards(self):
        d = self.d("Ah Kh", "Qh 7c 2d")
        self.assertEqual(len(d["backdoorFlushDraws"]), 1)
        self.assertEqual(d["backdoorFlushDraws"][0]["holeCardCount"], 2)
        self.assertTrue(d["backdoorFlushDraws"][0]["nut"])

    def test_backdoor_flush_one_hole_card(self):
        d = self.d("Ah Kd", "Qh 7h 2c")
        self.assertEqual(d["backdoorFlushDraws"][0]["holeCardCount"], 1)
        self.assertIsNone(d["flushDraw"])

    def test_backdoor_flush_absent(self):
        self.assertEqual(self.d("Ah Kd", "Qs 7c 2d")["backdoorFlushDraws"], [])

    def test_no_backdoor_on_turn(self):
        d = self.d("Ah Kd", "Qh 7h 2c 3s")
        self.assertEqual(d["backdoorFlushDraws"], [])
        self.assertIsNone(d["backdoorStraightDraw"])
        self.assertIsNone(d["flushDraw"])

    def test_flush_draw_two_hole_cards_nut(self):
        fd = self.d("Ah Kh", "Qh 7h 2c")["flushDraw"]
        self.assertEqual(fd["holeCardCount"], 2)
        self.assertTrue(fd["nut"])

    def test_flush_draw_one_hole_card_monotone(self):
        d = self.d("Ah Kd", "Qh 7h 2h")
        self.assertEqual(d["flushDraw"]["holeCardCount"], 1)
        self.assertTrue(d["flushDraw"]["nut"])
        self.assertIn("one hole card only", d["summary"])

    def test_flush_draw_non_nut_one_card(self):
        fd = self.d("Kh Qd", "9h 7h 2h")["flushDraw"]
        self.assertFalse(fd["nut"])
        self.assertEqual(fd["higherUnseen"], "A")

    def test_flush_draw_king_is_nut_when_ace_on_board(self):
        self.assertTrue(self.d("Kh 5h", "Ah 9h 2c")["flushDraw"]["nut"])

    def test_flush_draw_non_nut_two_cards(self):
        fd = self.d("9h 8h", "Kh 7h 3c")["flushDraw"]
        self.assertFalse(fd["nut"])
        self.assertEqual(fd["higherUnseen"], "A Q J T")

    def test_monotone_no_suit_card(self):
        d = self.d("As Kd", "Qh 7h 2h")
        self.assertIsNone(d["flushDraw"])
        self.assertEqual(d["backdoorFlushDraws"], [])

    def test_turn_one_card_flush_draw(self):
        fd = self.d("Ah Kd", "Qh 7h 2h 3c")["flushDraw"]
        self.assertEqual(fd["holeCardCount"], 1)

    def test_oesd(self):
        sd = self.d("9h 8d", "7c 6s 2h")["straightDraw"]
        self.assertEqual(sd["type"], "open-ended straight draw")
        self.assertEqual(sd["completingRanks"], ["T", "5"])
        self.assertEqual(sd["outs"], 8)

    def test_oesd_wheel(self):
        sd = self.d("5c 4d", "3h 2s 9c")["straightDraw"]
        self.assertEqual(sd["type"], "open-ended straight draw")
        self.assertEqual(sorted(sd["completingRanks"]), ["6", "A"])

    def test_double_gutshot(self):
        sd = self.d("9h 7d", "Js 8c 5h")["straightDraw"]
        self.assertEqual(sd["type"], "double gutshot straight draw")
        self.assertEqual(sd["completingRanks"], ["T", "6"])
        self.assertEqual(sd["outs"], 8)

    def test_broadway_one_ended(self):
        sd = self.d("Ac Kd", "Qs Jh 3c")["straightDraw"]
        self.assertEqual(sd["type"], "gutshot straight draw")
        self.assertEqual(sd["completingRanks"], ["T"])
        self.assertIn("one-ended", sd["description"])

    def test_broadway_gutshot(self):
        sd = self.d("Ac Kd", "Qs Th 3c")["straightDraw"]
        self.assertEqual(sd["type"], "gutshot straight draw")
        self.assertEqual(sd["completingRanks"], ["J"])
        self.assertNotIn("one-ended", sd["description"])

    def test_wheel_one_ended(self):
        sd = self.d("Ac 2d", "3s 4h 9c")["straightDraw"]
        self.assertEqual(sd["completingRanks"], ["5"])
        self.assertIn("one-ended", sd["description"])

    def test_wheel_gutshot(self):
        sd = self.d("Ac 5d", "2s 3h 9c")["straightDraw"]
        self.assertEqual(sd["completingRanks"], ["4"])
        self.assertNotIn("one-ended", sd["description"])

    def test_turn_gutshot(self):
        sd = self.d("9c 8d", "Jh 7s 2c 3d")["straightDraw"]
        self.assertEqual(sd["completingRanks"], ["T"])
        self.assertEqual(sd["type"], "gutshot straight draw")

    def test_board_four_straight_no_hero_draw(self):
        d = self.d("Ad 2c", "9c 8d 7h 6s")
        self.assertIsNone(d["straightDraw"])

    def test_already_straight_no_draw(self):
        self.assertIsNone(self.d("Td 2c", "9c 8d 7h 6s")["straightDraw"])

    def test_combo_draw_oesd(self):
        d = self.d("Jh Th", "9h 8h 2c")
        self.assertTrue(d["comboDraw"])
        o = facts("Jh Th", "9h 8h 2c")["outs"]
        self.assertEqual(o["straightOrBetter"]["count"], 15)

    def test_combo_draw_gutshot(self):
        d = self.d("Ah Kh", "Qh Th 2c")
        self.assertTrue(d["comboDraw"])
        self.assertEqual(facts("Ah Kh", "Qh Th 2c")["outs"]["straightOrBetter"]["count"], 12)

    def test_backdoor_straight_98(self):
        self.assertEqual(self.d("9h 8h", "Kh 7h 3c")["backdoorStraightDraw"], ["J-T", "T-6", "6-5"])

    def test_backdoor_straight_65(self):
        self.assertEqual(self.d("6c 5d", "Kh 8s 2d")["backdoorStraightDraw"], ["9-7", "7-4", "4-3"])

    def test_backdoor_straight_no_duplicates(self):
        # K-Q-J-T-9 and Q-J-T-9-8 both need Q and T: listed once
        self.assertEqual(self.d("Kc 9c", "Jc 8d 3s")["backdoorStraightDraw"], ["Q-T", "T-7"])
        self.assertIsNone(self.d("Kc 9c", "Jc 8d 3s")["straightDraw"])

    def test_no_overcards_under_ace(self):
        self.assertEqual(self.d("Ks Qs", "Ah 7s 2d")["overcards"], [])

    def test_two_overcards(self):
        d = self.d("Ah Kd", "9c 7s 2h")
        self.assertEqual(d["overcards"], ["ace", "king"])
        self.assertIn("two overcards (ace, king)", d["summary"])

    def test_nothing_explicit(self):
        self.assertEqual(self.d("2c 3d", "Kh Qs 8d")["summary"], "no draw")

    def test_river_no_draws(self):
        d = self.d("Ah Kh", "Qh 7h 2c 3s 9d")
        self.assertEqual(d["summary"], "no draws: river (no cards to come)")
        self.assertIsNone(d["flushDraw"])
        self.assertIsNone(facts("Ah Kh", "Qh 7h 2c 3s 9d")["outs"])

    def test_made_flush_no_flush_draw(self):
        self.assertIsNone(self.d("Ah 9h", "Kh 7h 2h")["flushDraw"])


class Outs(unittest.TestCase):
    def o(self, hole, board):
        return facts(hole, board)["outs"]

    def test_owner_case(self):
        o = self.o("As 4s", "Kc Qd 8h 3s")
        self.assertEqual(o["straightOrBetter"]["count"], 0)
        self.assertEqual(sorted(o["topPair"]["cards"]), ["Ac", "Ad", "Ah"])
        self.assertEqual(sorted(o["otherPair"]["cards"]), ["4c", "4d", "4h"])
        self.assertEqual(o["unseenCount"], 46)

    def test_flush_draw_9_outs(self):
        o = self.o("9h 8h", "Kh 7h 3c")
        self.assertEqual(o["straightOrBetter"]["count"], 9)
        self.assertEqual(o["unseenCount"], 47)

    def test_two_overcards_six_outs(self):
        self.assertEqual(self.o("Ah Kd", "9c 7s 2h")["topPair"]["count"], 6)

    def test_top_pair_improvements(self):
        o = self.o("Ah Kd", "Kc 7s 2h")
        self.assertEqual(o["twoPairOrTrips"]["count"], 5)
        self.assertEqual(o["topPair"]["count"], 0)

    def test_set_outs(self):
        o = self.o("7c 7d", "Kh 7s 2c")
        self.assertEqual(o["straightOrBetter"]["count"], 7)

    def test_underpair_set_outs(self):
        o = self.o("9s 9d", "Kh 7c 2d")
        self.assertEqual(sorted(o["twoPairOrTrips"]["cards"]), ["9c", "9h"])

    def test_two_pair_fh_outs(self):
        self.assertEqual(self.o("Kh 8d", "Kc 8s 3h")["straightOrBetter"]["count"], 4)

    def test_trips_turn_outs(self):
        self.assertEqual(self.o("Ks 9d", "Kh Kd 4c 7s")["straightOrBetter"]["count"], 10)

    def test_paired_board_overcards_to_top_pair(self):
        o = self.o("Ah Qd", "8c 8s 3h")
        self.assertEqual(o["topPair"]["count"], 6)

    def test_board_four_straight_cards_not_outs(self):
        o = self.o("Ad 2c", "9c 8d 7h 6s")
        self.assertEqual(o["straightOrBetter"]["count"], 0)


class Texture(unittest.TestCase):
    def t(self, board):
        return hf.texture([hf.parse(c) for c in P(board)])

    def test_rainbow_unpaired(self):
        t = self.t("Kc Qd 8h")
        self.assertEqual(t["suits"], "rainbow")
        self.assertEqual(t["pairing"], "unpaired board")

    def test_two_tone(self):
        self.assertEqual(self.t("Kh 7h 3c")["suits"], "two-tone")

    def test_monotone(self):
        t = self.t("Qh 7h 2h")
        self.assertEqual(t["suits"], "monotone")
        self.assertIn("three to a flush", t["flush"])

    def test_four_flush_turn(self):
        self.assertIn("four to a flush", self.t("Qh 7h 2h 3h")["flush"])

    def test_paired_board(self):
        self.assertEqual(self.t("Kh Kd 4c")["pairing"], "paired board (kings)")

    def test_trips_board(self):
        self.assertEqual(self.t("7c 7d 7s")["pairing"], "trips on the board")

    def test_three_straight(self):
        t = self.t("9c 8d 7h")
        self.assertIn("three to a straight", t["straight"])
        self.assertEqual(t["straightTwoCardCombos"], ["JT", "T6", "65"])

    def test_four_straight(self):
        t = self.t("9c 8d 7h 6s")
        self.assertEqual(t["straightSingleCards"], ["T", "5"])

    def test_no_straight(self):
        self.assertEqual(self.t("Kh 7s 2c")["straight"], "no straight possible yet")

    def test_board_straight(self):
        self.assertIn("straight on the board", self.t("9h 8s 7d 6c 5h")["straight"])


class NewCard(unittest.TestCase):
    def n(self, hole, board, prev):
        return facts(hole, board, prev)["newCard"]

    def test_pairs_board(self):
        self.assertTrue(self.n("Ah Qd", "Kh 7s 2c Kd", "Kh 7s 2c")["pairsBoard"])

    def test_overcard_to_pair(self):
        n = self.n("Jh Ts", "Jc 7d 2s Ah", "Jc 7d 2s")
        self.assertTrue(n["overcardToYourPair"])
        self.assertTrue(n["newTopCard"])

    def test_third_heart(self):
        self.assertIn("flush is now possible", self.n("Ad Qc", "Kh 7h 2c 4h", "Kh 7h 2c")["flushChange"])

    def test_completes_straight_possibility(self):
        n = self.n("Ad Ac", "9c 8d 2s 7h", "9c 8d 2s")
        self.assertIn("new straights possible", n["straightChange"])

    def test_brick(self):
        # river 9d on Kh 7s 2c 3d: no pair, not a top card, second diamond on the
        # river (no flush), no new straight; AdQc gains nothing
        n = self.n("Ad Qc", "Kh 7s 2c 3d 9d", "Kh 7s 2c 3d")
        self.assertTrue(n["brick"], n["summary"])

    def test_second_suited_card_is_not_a_brick(self):
        # fix 2: a second club on the turn makes a club flush draw possible
        n = self.n("Ad Qc", "Kh 7s 2c 3c", "Kh 7s 2c")
        self.assertFalse(n["brick"])
        self.assertIn("second club: a flush draw in clubs is now possible", n["summary"])

    def test_new_straight_draws_alone_do_not_count(self):
        # 3d on K-7-2 rainbow: gives 5-4 an open-ended draw, but no pair, no new
        # top card, no flush or flush draw, no made straight possible -> brick
        n = self.n("Ad Qc", "Kh 7s 2c 3d", "Kh 7s 2c")
        self.assertTrue(n["brick"], n["summary"])
        self.assertEqual(n["summary"], "brick: changes nothing on the board and does not improve your hand")
        self.assertNotIn("straightDrawChange", n)

    def test_made_straight_possible_is_a_change(self):
        # 7h on 9c 8d 2s makes JT, T6, 65 straights possible
        n = self.n("Ad Qc", "9c 8d 2s 7h", "9c 8d 2s")
        self.assertFalse(n["brick"])
        self.assertIn("makes new straights possible (two cards: JT, T6, 65)", n["summary"])

    def test_hero_draw_prevents_brick_wording(self):
        # Jd on K-4-2 rainbow gives JT a gutshot (Q): board quiet, hero changed
        n = self.n("Jh Td", "Kc 4s 2h 9d", "Kc 4s 2h")
        self.assertFalse(n["brick"])
        self.assertIn("no change on the board", n["summary"])
        self.assertIn("you pick up a gutshot straight draw", n["summary"])

    def test_picks_up_flush_draw(self):
        # fix 3: backdoor flush draw becomes the nut flush draw
        n = self.n("Ah 5h", "Qh 7c 2d 9h", "Qh 7c 2d")
        self.assertEqual(n["pickedUpDraws"], ["a nut flush draw"])
        self.assertIn("you pick up a nut flush draw", n["summary"])
        self.assertNotIn("does not improve your hand", n["summary"])

    def test_picks_up_gutshot(self):
        n = self.n("Jh Td", "Kc 4s 2h 9c", "Kc 4s 2h")
        self.assertIn("a gutshot straight draw", n["pickedUpDraws"])

    def test_new_card_uses_hero_hand_wording(self):
        # fix 6: the board pair is not called hero's pair
        n = self.n("Ac Kh", "9s 9c 4d 2h", "9s 9c 4d")
        self.assertIn("no pair of your own", n["heroHandAfter"])
        self.assertNotIn("pair -> pair", n["summary"])
        n = self.n("4c 4h", "Jd 9h 6c 2s Ac", "Jd 9h 6c 2s")
        made = hf.made_hand([hf.parse(c) for c in P("4c 4h")], [hf.parse(c) for c in P("Jd 9h 6c 2s Ac")])
        self.assertIn("your hand: " + n["heroHandBefore"] + " -> " + made["description"], n["summary"])

    def test_underpair_names_lower_board_cards(self):
        # p113: below every card on the flop; on the turn the 2 is under the fours
        self.assertIn("below every board card", facts("4c 4h", "Jd 9h 6c")["made"]["description"])
        self.assertIn("below the top card (underpair to three board cards: J 9 6; above 2)",
                      facts("4c 4h", "Jd 9h 6c 2s")["made"]["description"])

    def test_completes_flush_draw(self):
        n = self.n("Ah Kh", "Qh 7h 2c 5h", "Qh 7h 2c")
        self.assertTrue(n["heroImproved"])
        self.assertIn("completes your flush draw", n["previousDraws"])

    def test_missed_river(self):
        n = self.n("9h 8h", "Kh 7h 3c 2s Jd", "Kh 7h 3c 2s")
        self.assertIn("your flush draw missed", n["previousDraws"])
        self.assertFalse(n["heroImproved"])

    def test_board_pair_is_not_hero_improvement(self):
        n = self.n("Kh Qd", "Kc 7s 2h 7d", "Kc 7s 2h")
        self.assertFalse(n["heroImproved"])


class Grading(unittest.TestCase):
    def test_price_definition(self):
        # p002 decision 1: pot 7.3 includes the bet, to call 1.8 -> 1.8 / 9.1 = 19.8%
        sol = find_solution("p002")
        f = hf.build_facts(sol)
        s = f["decisions"][1]["situation"]
        self.assertEqual(s["equityNeededPct"], 19.8)
        self.assertEqual(s["price"], "call 1.8 to win 7.3")

    def test_js_round(self):
        self.assertEqual(hf.js_round(2.5), 3)
        self.assertEqual(hf.js_round(-2.5), -2)
        self.assertEqual(hf.js_round(0.49), 0)

    def test_tiny_loss_is_correct(self):
        # p002 decision 1: Call 1.8 played 2.1%, same EV as the raise -> Correct, 60 + 40*0.021/0.979
        sol = find_solution("p002")
        d = [s for s in sol["steps"] if s["type"] == "decision" and s["index"] == 1][0]
        g = hf.grade_decision(d, "call")
        self.assertEqual(g["grade"], "correct")
        self.assertEqual(g["points"], hf.round2(60 + 40 * 0.021 / 0.979))
        self.assertEqual(hf.grade_decision(d, "fold")["grade"], "blunder")

    def test_tiny_loss_rule_boundaries(self):
        def dec(ev, freq, pot=10.0, source="solver"):
            return {"options": [{"id": "a"}, {"id": "b"}], "source": source, "state": {"pot": pot},
                    "hand": {"freq": freq, "ev": ev if source == "solver" else None}}
        # never played, loss exactly 0.2% of pot (0.02 / 10) -> Correct 60
        g = hf.grade_decision(dec([1.0, 0.98], [1.0, 0.0]), "b")
        self.assertEqual((g["grade"], g["points"]), ("correct", 60))
        # loss 0.3% -> Inaccuracy as before
        self.assertEqual(hf.grade_decision(dec([1.0, 0.97], [1.0, 0.0]), "b")["grade"], "inaccuracy")
        # chart decisions unchanged: used rarely -> Inaccuracy, never -> Wrong
        self.assertEqual(hf.grade_decision(dec(None, [0.99, 0.01], source="chart"), "b")["grade"], "inaccuracy")
        self.assertEqual(hf.grade_decision(dec(None, [1.0, 0.0], source="chart"), "b")["grade"], "wrong")

    def test_grades_match_node(self):
        sol_dir = os.path.join(ROOT, "data/solutions")
        files = sorted(f for f in os.listdir(sol_dir) if f.endswith(".json"))[:20]
        cases = []
        decs = []
        for fn in files:
            sol = load(os.path.join(sol_dir, fn))
            for s in sol["steps"]:
                if s["type"] != "decision":
                    continue
                slim = {k: s[k] for k in ("options", "hand", "source", "state")}
                for o in s["options"]:
                    cases.append((len(decs), o["id"]))
                decs.append(slim)
        js = (
            "import('" + os.path.join(ROOT, "server/lib/grading.mjs") + "').then(m => {"
            "const inp = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
            "const out = inp.cases.map(([i, id]) => m.gradeDecision(inp.decs[i], id));"
            "process.stdout.write(JSON.stringify(out)); });"
        )
        r = subprocess.run(["node", "-e", js], input=json.dumps({"decs": decs, "cases": cases}),
                           capture_output=True, text=True, check=True)
        node_out = json.loads(r.stdout)
        self.assertEqual(len(node_out), len(cases))
        self.assertGreater(len(cases), 150)
        for (i, oid), want in zip(cases, node_out):
            got = hf.grade_decision(decs[i], oid)
            for key in ("grade", "label", "points", "freq", "maxFreq", "loss", "lossPct"):
                self.assertEqual(got[key], want[key], (i, oid, key, got, want))


class WholeFiles(unittest.TestCase):
    def test_owner_example_in_text(self):
        f = hf.hand_facts(["As", "4s"], ["Kc", "Qd", "8h", "3s"], ["Kc", "Qd", "8h"])
        self.assertNotIn("flush draw", f["draws"]["summary"])
        self.assertNotIn("backdoor", f["draws"]["summary"])


class HandTypes(unittest.TestCase):
    """Hand type of one combo on a board, worked out by hand."""
    CASES = [
        ("As Ks", "Kh 7c 2d", "top pair, good kicker"),
        ("Ks 9s", "Kh 7c 2d", "top pair, weak kicker"),
        ("Ks Qd", "Kh 7c 2d", "top pair, good kicker"),
        ("Ah Kd", "Ac Kc 3d", "two pair"),
        ("7s 7d", "Kh 7c 2d", "set or trips"),
        ("Ah 7d", "7c 7s 2d", "set or trips"),
        ("Qs Qd", "Jh 7c 2d", "overpair"),
        ("9s 9d", "Kh 7c 2d", "middle or bottom pair, underpair"),
        ("7s 6s", "Kh 7c 2d", "middle or bottom pair, underpair"),
        ("9h 8h", "Kh 7h 3c", "strong draw"),
        ("9s 8d", "7c 6s 2h", "strong draw"),
        ("9h 7d", "Js 8c 5h", "strong draw"),
        ("Ac Kd", "Qs Th 3c", "weak draw"),
        ("Ah 5d", "Kc 9s 2h", "weak draw"),
        ("6c 5d", "Kh 9s 2d", "weak draw"),
        ("3c 2d", "Kh Qs 8d", "nothing"),
        ("3c 2d", "Kh Qs 8d 7c", "nothing"),
        ("Ah Kh", "Qh 7h 2c 3s 9d", "nothing"),
        ("2c 3d", "9h 8s 7d 6c 5h", "nothing"),
        ("Tc 2d", "9h 8s 7d 6c 5h", "straight or better"),
        ("Ah Kd", "Qh 7h 2h", "strong draw"),
        ("As Kd", "Qh 7h 2h", "weak draw"),
        ("9h 8h", "Kh 7h 2h", "straight or better"),
        ("Td 2c", "9c 8d 7h 6s", "straight or better"),
        ("Ad 2c", "9c 8d 7h 6s", "weak draw"),
        ("4d 2c", "9c 8d 7h 6s", "nothing"),
        ("Ah Qd", "8c 8s 3h", "weak draw"),
        ("Jh Jd", "8c 8s 3h", "overpair"),
        ("3c 3d", "Kh Ks 9c", "middle or bottom pair, underpair"),
        ("Ah 5d", "Ac 9s 9d", "top pair, weak kicker"),
        ("7c 7d", "7s Kh Kd", "straight or better"),
        ("Ah Qd", "7c 7d 7s", "weak draw"),
        ("Kd Qd", "5h 5c 3s Jd", "weak draw"),
        ("Qh Qd", "Ah Kh 2c 3d 7s", "middle or bottom pair, underpair"),
        ("Ac Kd", "Qs Js Th 2c 3d", "straight or better"),
    ]

    def test_cases(self):
        for hole, board, want in self.CASES:
            with self.subTest(hole=hole, board=board):
                got, _ = hf.hand_type(tuple(hf.parse(c) for c in P(hole)), [hf.parse(c) for c in P(board)])
                self.assertEqual(got, want)

    def test_pair_with_flush_draw_flag(self):
        t, sd = hf.hand_type(tuple(hf.parse(c) for c in P("Ah 5h")), [hf.parse(c) for c in P("5c Kh 9h")])
        self.assertEqual((t, sd), ("middle or bottom pair, underpair", True))

    def test_good_kickers(self):
        self.assertEqual(hf.good_kickers([hf.parse(c) for c in P("Kh 7c 2d")]), [14, 12, 11])
        self.assertEqual(hf.good_kickers([hf.parse(c) for c in P("Ah Kc 2d")]), [12, 11, 10])

    def test_class_cards(self):
        self.assertEqual(len(hf.class_cards(hf.class_index("AA"))), 6)
        self.assertEqual(len(hf.class_cards(hf.class_index("AKs"))), 4)
        ako = hf.class_cards(hf.class_index("AKo"))
        self.assertEqual(len(ako), 12)
        self.assertTrue(all(a[0] == 14 and b[0] == 13 and a[1] != b[1] for a, b in ako))
        self.assertTrue(all(a[1] == b[1] for a, b in hf.class_cards(hf.class_index("T9s"))))

    def test_fast_value_matches(self):
        import random
        rnd = random.Random(7)
        deck = [hf.parse(c) for c in hf.FULL_DECK]
        for _ in range(3000):
            ranks = rnd.sample(range(2, 15), rnd.choice([3, 4, 5, 7, 13]))
            suits = rnd.sample("shdc", rnd.choice([1, 2, 4]))
            pool = [c for c in deck if c[0] in ranks and c[1] in suits]
            n = rnd.choice([5, 6, 7])
            if len(pool) < n:
                continue
            cs = rnd.sample(pool, n)
            self.assertEqual(hf.fast_value(cs), hf.value_of(cs), cs)


class RangeTypes(unittest.TestCase):
    def grid(self, weights, freqs=None, n=2):
        w = [0.0] * 169
        f = [[0.0] * n for _ in range(169)]
        for name, x in weights.items():
            w[hf.class_index(name)] = x
            if freqs and name in freqs:
                f[hf.class_index(name)] = freqs[name]
        return w, f

    def test_board_collisions_not_counted(self):
        # AA on Ah 7c 2d: 3 live combos (no Ah); class weight 1 -> 6 combos spread over them
        w, f = self.grid({"AA": 1.0})
        rt = hf.range_by_type(w, f, [hf.parse(c) for c in P("Ah 7c 2d")])
        self.assertAlmostEqual(rt["total"], 6.0)
        self.assertAlmostEqual(rt["types"]["set or trips"]["w"], 6.0)

    def test_hero_cards_removed(self):
        w, f = self.grid({"AA": 1.0})
        rt = hf.range_by_type(w, f, [hf.parse(c) for c in P("Ah 7c 2d")], exclude=[hf.parse("As")])
        self.assertAlmostEqual(rt["total"], 2.0)  # only AdAc is left

    def test_suited_class_two_live(self):
        # AKs on Ah Kd 2c: AhKh and AdKd use board cards; AsKs, AcKc live
        w, f = self.grid({"AKs": 0.5})
        rt = hf.range_by_type(w, f, [hf.parse(c) for c in P("Ah Kd 2c")])
        self.assertAlmostEqual(rt["total"], 2.0)
        self.assertAlmostEqual(rt["types"]["two pair"]["w"], 2.0)

    def test_flush_draw_counted_per_suit(self):
        # 98s on Kh 7h 3c: 9h8h has a flush draw (strong), 9s8s/9d8d/9c8c only gutshot? no:
        # 9-8 with 7 needs T and 6 -> no single-card straight; backdoor straight -> weak draw
        w, f = self.grid({"98s": 1.0})
        rt = hf.range_by_type(w, f, [hf.parse(c) for c in P("Kh 7h 3c")])
        self.assertAlmostEqual(rt["types"]["strong draw"]["w"], 1.0)
        self.assertAlmostEqual(rt["types"]["weak draw"]["w"], 3.0)

    def test_option_split_and_makeup(self):
        w, f = self.grid({"AA": 1.0, "32o": 1.0}, {"AA": [0.25, 0.75], "32o": [1.0, 0.0]})
        rt = hf.range_by_type(w, f, [hf.parse(c) for c in P("Kh 7c 9d")], n_opts=2)
        sm = hf.summarize_types(rt, ["Check", "Bet"])
        rows = {r["type"]: r for r in sm["types"]}
        self.assertEqual(rows["overpair"]["pct"], round(100 * 6 / 18, 1))
        self.assertEqual(rows["overpair"]["split"], {"Check": 25.0, "Bet": 75.0})
        self.assertEqual(rows["nothing"]["split"], {"Check": 100.0, "Bet": 0.0})
        self.assertEqual(sm["optionMakeup"]["Bet"], [{"type": "overpair", "pct": 100.0}])
        self.assertEqual(sm["optionCombos"]["Bet"], 4.5)

    def test_versus_type(self):
        w, f = self.grid({"AA": 1.0, "KK": 1.0, "32o": 1.0})
        rt = hf.range_by_type(w, None, [hf.parse(c) for c in P("Qh 7c 9d")])
        v = hf.versus_type("top pair, good kicker", rt)
        self.assertEqual(v["strongerTypePct"], 50.0)  # 12 overpair combos of 24
        self.assertEqual(v["nothingPct"], 50.0)


class Blockers(unittest.TestCase):
    def b(self, hole, board):
        return hf.blockers([hf.parse(c) for c in P(hole)], [hf.parse(c) for c in P(board)])

    def test_nut_flush_ace(self):
        self.assertIn("you hold the Ah, the highest heart not on the board: villain cannot have the nut flush",
                      self.b("Ah 5d", "Kh 9h 2h"))

    def test_nut_flush_king_when_ace_on_board(self):
        self.assertTrue(any("the Kh, the highest heart" in x for x in self.b("Kh 5d", "Ah 9h 2h")))

    def test_non_nut_suit_card(self):
        out = self.b("Qh 5d", "Ah 9h 2h")
        self.assertTrue(any("1 heart (Qh)" in x for x in out), out)
        self.assertFalse(any("nut" in x for x in out))

    def test_nut_flush_draw_blocker(self):
        self.assertTrue(any("cannot have the nut flush draw" in x for x in self.b("Ad 5c", "Kd 9d 2s")))

    def test_river_two_suited_no_flush_blocker(self):
        self.assertEqual(self.b("Ad 5c", "Kd 9d 2s 3h 7c"), ["no relevant blockers"])

    def test_top_rank(self):
        self.assertEqual(self.b("Kc 5d", "Kh 9s 2d"),
                         ["you hold a king of the top board rank: villain has fewer top pairs (2 kings left unseen)"])

    def test_paired_rank(self):
        self.assertEqual(self.b("Ah 5d", "Ac As 9d"),
                         ["you hold an ace of the paired board rank: villain has fewer trips (1 ace left unseen)"])

    def test_four_straight_single_card(self):
        self.assertTrue(any("you hold a ten, a card that alone makes a straight" in x for x in self.b("Td 2c", "9c 8d 7h 6s")))

    def test_three_connected(self):
        out = self.b("Jd 3c", "Th 9s 8c")
        self.assertTrue(any("two-card straights QJ, J7" in x for x in out), out)

    def test_none(self):
        self.assertEqual(self.b("3c 2d", "Kh Qs 8d"), ["no relevant blockers"])


class Strategic(unittest.TestCase):
    def test_spr_band(self):
        self.assertEqual(hf.spr_band(13.1), "deep (SPR above 6)")
        self.assertEqual(hf.spr_band(6.0), "medium (SPR 3 to 6)")
        self.assertEqual(hf.spr_band(3.0), "medium (SPR 3 to 6)")
        self.assertEqual(hf.spr_band(1.96), "shallow (SPR below 3)")

    def test_p002_position_and_initiative(self):
        f = hf.build_facts(find_solution("p002"))
        d1, d2 = f["decisions"][1]["strategic"], f["decisions"][2]["strategic"]
        self.assertFalse(d1["position"]["heroInPosition"])
        self.assertIn("hero is out of position", d1["position"]["text"])
        self.assertIn("last bet or raise on the preflop: villain (BTN raise 2.5)", d1["initiative"])
        self.assertIn("on this street so far: villain (BTN Bet 1.8 (33%))", d1["initiative"])
        self.assertEqual(d2["previousStreetAggressor"], "hero")
        self.assertIn("no bet yet on this street", d2["initiative"])
        self.assertEqual(d1["heroHandType"]["type"], "strong draw")
        self.assertEqual(f["decisions"][3]["strategic"]["heroHandType"]["type"], "nothing")


class ReviewFixes(unittest.TestCase):
    def test_backdoor_straight_beaten_by_board(self):
        # fix 1: A-x on 6-5-4 must not list runner-runner 3-2 (6-high straight on the board)
        bd = hf.backdoor_straight_windows([hf.parse(c) for c in P("Ad 9c")], [hf.parse(c) for c in P("6s 5h 4c")])
        self.assertNotIn("3-2", bd)
        self.assertEqual(bd, ["8-7"])
        self.assertIsNone(facts("Ac Kd", "6s 5h 4c")["draws"]["backdoorStraightDraw"])

    def test_board_and_new_card_list_straights_alike(self):
        # fix 4
        t = hf.texture([hf.parse(c) for c in P("Th 9s 8c 6d")])
        self.assertEqual(t["straight"], "four to a straight: one card makes a straight (straights with one card: 7; two cards: QJ)")
        n = facts("Ad Ac", "9c 8d 6s 5h", "9c 8d 6s")["newCard"]
        self.assertEqual(n["straightChange"], "makes new straights possible (one card: 7)")
        self.assertIn("one card: 7", facts("Ad Ac", "9c 8d 6s 5h")["texture"]["straight"])

    def test_loss_pct_display(self):
        # fix 5: never print a figure that sits on a grade boundary the value is not on
        self.assertEqual(hf.loss_pct_display(0.2198), 0.22)
        self.assertEqual(hf.loss_pct_display(0.2049), 0.205)
        self.assertEqual(hf.loss_pct_display(0.199), 0.199)
        self.assertEqual(hf.loss_pct_display(0.2), 0.2)
        self.assertEqual(hf.loss_pct_display(1.46), 1.46)
        self.assertEqual(hf.loss_pct_display(5.96), 5.96)
        self.assertEqual(hf.loss_pct_display(2.345), 2.3)
        self.assertEqual(hf.loss_pct_display(0.04), 0.04)

    def test_no_price_on_open_raise(self):
        # fix 7: RFI chart (nobody has bet) -> no price line; facing an open -> price
        f = hf.build_facts(find_solution("p001"))
        d0 = f["decisions"][0]
        self.assertTrue(d0["chart"].endswith("RFI"))
        self.assertNotIn("price", d0["situation"])
        self.assertFalse(d0["situation"]["facingBetOrRaise"])
        txt = hf.to_text(f)
        self.assertNotIn("Price: call 1 to win 1.5", txt)
        g = hf.build_facts(find_solution("p002"))
        self.assertEqual(g["decisions"][0]["situation"]["price"], "call 1.5 to win 4")

    def test_outs_label_above_current_hand(self):
        # fix 8: hero already has a straight -> outs are to a flush or better
        o = facts("6s 5s", "8c 7d 4s 9s")["outs"]
        self.assertEqual(o["straightOrBetter"]["label"], "to a flush or better")
        self.assertEqual(facts("9h 8h", "Kh 7h 3c")["outs"]["straightOrBetter"]["label"], "to a straight or better")

    def test_villain_type_lines_name_the_action(self):
        # fix 9: the line names the action; a frequent bet alternative gets its own line
        f = hf.build_facts(find_solution("p002"))
        river_check = f["afterLastDecision"][-1]
        self.assertEqual(river_check["handTypes"]["action"], "Check")
        self.assertEqual(river_check["alternativeHandTypes"]["action"], "Bet 20.4 (50%)")
        lines = hf.villain_type_lines(river_check)
        self.assertTrue(lines[0].strip().startswith("villain hand types taking this action: CHECK (the action villain took"))
        self.assertTrue(lines[1].strip().startswith("villain hand types that would BET 20.4 (50%) here (the alternative villain did NOT take"))
        flop_bet = f["decisions"][1]["eventsSinceLastDecision"][-1]
        self.assertNotIn("alternativeHandTypes", flop_bet)  # main alternative is a check

    def test_header_explains_main_line_vs_best_by_ev(self):
        # fix 10
        self.assertIn('"Best by EV" can name a\n  different option than the main line', hf.TXT_HEADER)


if __name__ == "__main__":
    unittest.main(verbosity=1)
