"""Synthetic-segment tests for index_continuous (no YOLO, no video).

Run: scripts/videos/venv/bin/python -m unittest scripts/videos/test_index_continuous.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from index_continuous import index_games  # noqa: E402

EPOCH = 1_000_000.0


def seg(name, start_off, dur):
    return {"path": name, "start": EPOCH + start_off, "duration": dur}


def rows_for(start_off, dur, n_at):
    """1 Hz rows for a segment; n_at(global_s) -> persons on court."""
    return [{"t": float(t), "n": n_at(start_off + t)} for t in range(int(dur))]


def played(*spans):
    """n_at that is 4 inside any (a, b) span of global seconds, else 0."""
    return lambda g: 4 if any(a <= g < b for a, b in spans) else 0


class StitchTests(unittest.TestCase):
    def test_game_spanning_cuts_is_one_game(self):
        # One 20-minute game straddling TWO 10-minute segment cuts.
        n_at = played((300, 1500))
        segs = [seg("a.ts", 0, 600), seg("b.ts", 600, 600), seg("c.ts", 1200, 600)]
        rows = {s["path"]: rows_for(s["start"] - EPOCH, 600, n_at) for s in segs}
        out = index_games(segs, rows, None, capture_ended=True)
        self.assertEqual(len(out["games"]), 1)
        g = out["games"][0]
        self.assertAlmostEqual(g["start"] - EPOCH, 300, delta=2)
        self.assertAlmostEqual(g["end"] - EPOCH, 1500, delta=2)
        self.assertEqual((g["source_segment"], g["end_segment"]), ("a.ts", "c.ts"))
        self.assertAlmostEqual(g["offset"], 300, delta=2)
        self.assertAlmostEqual(g["end_offset"], 300, delta=2)
        self.assertFalse(g["unfinished"])

    def test_two_games_split_by_empty_court_not_by_cut(self):
        n_at = played((0, 590), (640, 1190))  # empty 50 s across the cut at 600
        segs = [seg("a.ts", 0, 600), seg("b.ts", 600, 600)]
        rows = {s["path"]: rows_for(s["start"] - EPOCH, 600, n_at) for s in segs}
        games = index_games(segs, rows, None, capture_ended=True)["games"]
        self.assertEqual(len(games), 2)

    def test_unfinished_means_capture_ended_not_file_ended(self):
        n_at = played((100, 1200))
        segs = [seg("a.ts", 0, 600), seg("b.ts", 600, 600)]
        rows = {s["path"]: rows_for(s["start"] - EPOCH, 600, n_at) for s in segs}
        # Recording still going: the open span is withheld, not a game.
        live = index_games(segs, rows, None, capture_ended=False)
        self.assertEqual(live["games"], [])
        self.assertAlmostEqual(live["open_tail_start"] - EPOCH, 100, delta=2)
        # Recording over: same footage, now an UNFINISHED game.
        done = index_games(segs, rows, None, capture_ended=True)["games"]
        self.assertEqual(len(done), 1)
        self.assertTrue(done[0]["unfinished"])

    def test_rolling_window_carries_game_across_the_join(self):
        n_at = played((100, 1000))
        s1, s2 = seg("a.ts", 0, 600), seg("b.ts", 600, 600)
        r = lambda s: rows_for(s["start"] - EPOCH, 600, n_at)
        first = index_games([s1], {"a.ts": r(s1)}, None)
        self.assertEqual(first["games"], [])
        # Next run starts from the carried tail and sees the rest.
        second = index_games([s1, s2], {"a.ts": r(s1), "b.ts": r(s2)}, None,
                             capture_ended=True)
        self.assertEqual(len(second["games"]), 1)

    def test_missing_segment_is_a_gap_not_an_empty_court(self):
        n_at = played((100, 400), (1300, 1500))
        segs = [seg("a.ts", 0, 600), seg("c.ts", 1200, 600)]  # b.ts missing
        rows = {s["path"]: rows_for(s["start"] - EPOCH, 600, n_at) for s in segs}
        games = index_games(segs, rows, None, capture_ended=True)["games"]
        self.assertEqual(len(games), 2)
        self.assertEqual(games[0]["end_cut"], None)  # court emptied for real
        self.assertEqual(games[1]["start_cut"], "gap")


class GateTests(unittest.TestCase):
    def test_overnight_emptiness_yields_zero_games(self):
        segs = [seg(f"{i}.ts", i * 600, 600) for i in range(6)]
        rows = {s["path"]: rows_for(s["start"] - EPOCH, 600, lambda g: 0) for s in segs}
        self.assertEqual(index_games(segs, rows, [], capture_ended=True)["games"], [])
        self.assertEqual(index_games(segs, rows, None, capture_ended=True)["games"], [])

    def test_n_real_games_in_booked_window_give_n(self):
        n_at = played((100, 400), (500, 800), (900, 1150))
        segs = [seg("a.ts", 0, 600), seg("b.ts", 600, 600)]
        rows = {s["path"]: rows_for(s["start"] - EPOCH, 600, n_at) for s in segs}
        win = [[EPOCH, EPOCH + 1200]]
        games = index_games(segs, rows, win, capture_ended=True)["games"]
        self.assertEqual(len(games), 3)

    def test_play_outside_booked_window_is_ignored(self):
        n_at = played((100, 400), (2000, 2300))
        segs = [seg(f"{i}.ts", i * 600, 600) for i in range(4)]
        rows = {s["path"]: rows_for(s["start"] - EPOCH, 600, n_at) for s in segs}
        win = [[EPOCH, EPOCH + 600]]
        games = index_games(segs, rows, win, capture_ended=True)["games"]
        self.assertEqual(len(games), 1)

    def test_play_cut_by_window_close_is_not_unfinished(self):
        n_at = played((100, 1000))
        segs = [seg("a.ts", 0, 600), seg("b.ts", 600, 600)]
        rows = {s["path"]: rows_for(s["start"] - EPOCH, 600, n_at) for s in segs}
        win = [[EPOCH, EPOCH + 700]]
        g = index_games(segs, rows, win, capture_ended=True)["games"][0]
        self.assertFalse(g["unfinished"])
        self.assertEqual(g["end_cut"], "window")


if __name__ == "__main__":
    unittest.main()
