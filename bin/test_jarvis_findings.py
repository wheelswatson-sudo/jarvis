#!/usr/bin/env python3
"""
test_jarvis_findings — round-trip tests for the findings data layer.

Run:
    python3 ~/jarvis/bin/test_jarvis_findings.py        # all tests, terse
    python3 ~/jarvis/bin/test_jarvis_findings.py -v     # verbose

These tests use a per-test temp directory and isolated SQLite DB; they do NOT
touch the real ~/.jarvis/findings/ store or the real memory.db. Safe to run
alongside live use.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

# Import the data layer from the same dir as this test file.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import jarvis_findings as jf


class FindingsTest(unittest.TestCase):
    """Base class — redirects all jf paths to a temp dir per test."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="jf_test_")
        root = Path(self.tmp)
        # Override ALL module-level paths to the temp dir, including the cache
        # paths — otherwise tests would overwrite the real ~/.jarvis/findings/
        # .cache/stats.json with garbage from temp data.
        self._orig = {
            "ROOT": jf.ROOT, "ACTIVE": jf.ACTIVE, "SUPERSEDED": jf.SUPERSEDED,
            "OUTDATED": jf.OUTDATED, "COLD": jf.COLD, "PURGED": jf.PURGED,
            "CACHE": jf.CACHE, "STATS_CACHE": jf.STATS_CACHE,
            "EVENTS": jf.EVENTS, "INDEX": jf.INDEX, "DB": jf.DB,
        }
        jf.ROOT = root
        jf.ACTIVE = root / "active"
        jf.SUPERSEDED = root / "superseded"
        jf.OUTDATED = root / "outdated"
        jf.COLD = root / "cold"
        jf.PURGED = root / ".purged"
        jf.CACHE = root / ".cache"
        jf.STATS_CACHE = root / ".cache" / "stats.json"
        jf.EVENTS = root / "events.jsonl"
        jf.INDEX = root / "index.md"
        jf.DB = root / "memory.db"
        jf.ensure_dirs()

    def tearDown(self) -> None:
        for k, v in self._orig.items():
            setattr(jf, k, v)
        # Clean temp dir
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestCapture(FindingsTest):

    def test_capture_creates_file_and_event(self):
        fid, status = jf.capture(
            "Test claim 1", "fact", confidence="medium",
            verified_by="training-knowledge",
            tags=["test"], trigger="unit test",
        )
        self.assertEqual(status, "new")
        self.assertTrue((jf.ACTIVE / f"{fid}.md").exists())
        self.assertTrue(jf.EVENTS.exists())
        events = jf.tail(10)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "capture")
        self.assertEqual(events[0]["finding_id"], fid)

    def test_capture_idempotent_on_exact_claim(self):
        fid1, s1 = jf.capture("Same claim", "fact", verified_by="training-knowledge")
        fid2, s2 = jf.capture("Same claim", "fact", verified_by="training-knowledge")
        self.assertEqual(fid1, fid2)
        self.assertEqual(s1, "new")
        self.assertEqual(s2, "duplicate")

    def test_id_is_stable_under_normalization(self):
        # Same claim with different casing / punctuation should hash identically.
        a = jf.make_id("Anthropic prompt-cache TTL.")
        b = jf.make_id("anthropic prompt cache ttl")
        self.assertEqual(a, b)

    def test_render_then_parse_roundtrip(self):
        fid, _ = jf.capture(
            "Round-trip test", "opinion",
            confidence="medium", verified_by="training-knowledge",
            tags=["a", "b"], trigger="rt",
        )
        loaded = jf.load_finding(fid)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["claim"], "Round-trip test")
        self.assertEqual(loaded["type"], "opinion")
        self.assertEqual(loaded["tags"], ["a", "b"])

    def test_frontmatter_handles_special_chars_in_claim(self):
        # Claim with colon, hash, quotes — render must quote, parse must unquote.
        fid, _ = jf.capture(
            'Has "quotes" and: colons and # hash signs', "fact",
            verified_by="training-knowledge",
        )
        loaded = jf.load_finding(fid)
        self.assertEqual(
            loaded["claim"],
            'Has "quotes" and: colons and # hash signs',
        )


class TestDiscipline(FindingsTest):
    """Verification gate: the discipline guard that prevents fabricated facts."""

    def test_high_without_verified_by_refused(self):
        with self.assertRaises(ValueError) as cm:
            jf.capture("X", "fact", confidence="high")
        self.assertIn("verified-by", str(cm.exception).lower())

    def test_high_with_training_knowledge_refused(self):
        with self.assertRaises(ValueError) as cm:
            jf.capture("X", "fact", confidence="high", verified_by="training-knowledge")
        self.assertIn("not strong enough", str(cm.exception))

    def test_high_web_fetched_requires_url(self):
        with self.assertRaises(ValueError):
            jf.capture("X", "fact", confidence="high", verified_by="web-fetched")
        # With a web source, it should pass.
        fid, _ = jf.capture(
            "Y", "fact", confidence="high", verified_by="web-fetched",
            sources=[{"kind": "web", "url": "https://example.com", "fetched_ts": jf.now_iso()}],
        )
        self.assertTrue(fid.startswith("F-"))

    def test_high_code_requires_code_source(self):
        with self.assertRaises(ValueError):
            jf.capture("Z", "fact", confidence="high", verified_by="code")
        fid, _ = jf.capture(
            "W", "fact", confidence="high", verified_by="code",
            sources=[{"kind": "code", "url": "/tmp/x.py", "note": "test"}],
        )
        self.assertTrue(fid.startswith("F-"))

    def test_medium_with_training_knowledge_allowed(self):
        fid, _ = jf.capture(
            "Medium TK is fine", "fact",
            confidence="medium", verified_by="training-knowledge",
        )
        self.assertTrue(fid.startswith("F-"))

    def test_promote_to_high_requires_verified_by(self):
        fid, _ = jf.capture("Promote me", "fact",
                            confidence="medium", verified_by="training-knowledge")
        with self.assertRaises(ValueError):
            jf.revise(fid, confidence="high", reason="promotion attempt")

    def test_promote_to_high_with_verified_by_works(self):
        fid, _ = jf.capture("Promote me 2", "fact",
                            confidence="medium", verified_by="training-knowledge")
        ok = jf.revise(
            fid, confidence="high", verified_by="user-confirmed",
            reason="user said so explicitly",
        )
        self.assertTrue(ok)
        loaded = jf.load_finding(fid)
        self.assertEqual(loaded["confidence"], "high")
        self.assertEqual(loaded["verified_by"], "user-confirmed")


class TestRevise(FindingsTest):

    def test_revise_status_appends_event(self):
        fid, _ = jf.capture("Revise me", "fact", verified_by="training-knowledge")
        ok = jf.revise(fid, status="rejected", reason="found counterexample")
        self.assertTrue(ok)
        loaded = jf.load_finding(fid)
        self.assertEqual(loaded["status"], "rejected")
        events = [e for e in jf.tail(20) if e["event"] == "transition"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["from"], "open")
        self.assertEqual(events[0]["to"], "rejected")

    def test_revise_no_change_returns_false(self):
        fid, _ = jf.capture("Stable", "fact", verified_by="training-knowledge")
        ok = jf.revise(fid, status="open", reason="no actual change")
        self.assertFalse(ok)

    def test_revise_add_source_auto_transitions_to_investigating(self):
        fid, _ = jf.capture("Auto-investigating", "fact", verified_by="training-knowledge")
        loaded_before = jf.load_finding(fid)
        self.assertEqual(loaded_before["status"], "open")
        ok = jf.revise(fid, add_source="web,https://x.com,test source", reason="adding source")
        self.assertTrue(ok)
        loaded_after = jf.load_finding(fid)
        self.assertEqual(loaded_after["status"], "investigating")

    def test_revise_mark_reviewed_bumps_review_ts(self):
        fid, _ = jf.capture("Reviewed", "fact", verified_by="training-knowledge")
        before = jf.load_finding(fid)["last_review_ts"]
        # Force a measurable ts delta
        import time; time.sleep(1.05)
        ok = jf.revise(fid, mark_reviewed=True, reason="periodic review")
        self.assertTrue(ok)
        after = jf.load_finding(fid)["last_review_ts"]
        self.assertGreater(after, before)


class TestSupersede(FindingsTest):

    def test_supersede_moves_old_and_links_both(self):
        old_id, _ = jf.capture("Old claim about X", "fact", verified_by="training-knowledge")
        new_id, _ = jf.capture("New, more precise claim about X (totally different wording)",
                               "fact", verified_by="training-knowledge", force_new=True)
        self.assertNotEqual(old_id, new_id)
        ok = jf.supersede(new_id, old_id, reason="more precise")
        self.assertTrue(ok)
        # Old file moved to superseded/
        self.assertFalse((jf.ACTIVE / f"{old_id}.md").exists())
        self.assertTrue((jf.SUPERSEDED / f"{old_id}.md").exists())
        # Bidirectional links
        old_loaded = jf.load_finding(old_id)
        new_loaded = jf.load_finding(new_id)
        self.assertEqual(old_loaded["superseded_by"], new_id)
        self.assertEqual(old_loaded["status"], "superseded")
        self.assertIn(old_id, new_loaded["supersedes"])

    def test_doctor_clean_after_supersede(self):
        old_id, _ = jf.capture("Old A", "fact", verified_by="training-knowledge")
        new_id, _ = jf.capture("New A entirely different", "fact",
                               verified_by="training-knowledge", force_new=True)
        jf.supersede(new_id, old_id, reason="r")
        report = jf.doctor()
        self.assertTrue(report["ok"], msg=f"doctor reports: {report['issues']}")


class TestDedup(FindingsTest):

    def test_exact_dup_returns_duplicate_status(self):
        a, sa = jf.capture("Identical phrasing here", "fact", verified_by="training-knowledge")
        b, sb = jf.capture("Identical phrasing here", "fact", verified_by="training-knowledge")
        self.assertEqual(a, b)
        self.assertEqual(sb, "duplicate")

    def test_near_dup_blocked_without_force(self):
        # Need to actually have a finding indexed first
        a, _ = jf.capture(
            "The cat sat on the mat all day long",
            "fact", verified_by="training-knowledge",
        )
        # Very similar — should hit Jaccard >= 0.5
        b, sb = jf.capture(
            "The cat sat on the mat",
            "fact", verified_by="training-knowledge",
        )
        self.assertEqual(b, a, msg="near-dup should return existing F-id")
        self.assertEqual(sb, "near-duplicate")

    def test_force_new_overrides_near_dup(self):
        a, _ = jf.capture(
            "The dog barked at the moon",
            "fact", verified_by="training-knowledge",
        )
        b, sb = jf.capture(
            "The dog barked at the moon all night",
            "fact", verified_by="training-knowledge", force_new=True,
        )
        # With force-new, gets a different ID even if Jaccard would match
        self.assertNotEqual(a, b)
        self.assertEqual(sb, "new")


class TestPurge(FindingsTest):

    def test_purge_moves_to_purged_and_drops_from_query(self):
        fid, _ = jf.capture("Will be purged", "fact", verified_by="training-knowledge")
        self.assertIsNotNone(jf.find_path(fid))
        ok = jf.purge(fid, reason="test cleanup")
        self.assertTrue(ok)
        self.assertIsNone(jf.find_path(fid))
        self.assertTrue((jf.PURGED / f"{fid}.md").exists())
        events = [e for e in jf.tail(10) if e["event"] == "purge"]
        self.assertEqual(len(events), 1)

    def test_purge_requires_reason(self):
        fid, _ = jf.capture("X", "fact", verified_by="training-knowledge")
        with self.assertRaises(ValueError):
            jf.purge(fid, reason="")

    def test_purge_clears_superseded_by_backref(self):
        old_id, _ = jf.capture("Old will get superseded then purged",
                               "fact", verified_by="training-knowledge")
        new_id, _ = jf.capture("New entirely separate replacement claim",
                               "fact", verified_by="training-knowledge", force_new=True)
        jf.supersede(new_id, old_id, reason="r")
        # Now purge the new one — the old one's superseded_by should be cleared
        jf.purge(new_id, reason="test backref clearing")
        old_after = jf.load_finding(old_id)
        self.assertIsNone(old_after["superseded_by"])

    def test_purge_refuses_when_active_supersedes_target(self):
        # Setup: B (newer) supersedes A (older). A moves to superseded/.
        # B is still in active/ with B.supersedes=[A]. Purging A while B
        # references it should be refused — that would orphan B.supersedes.
        old_id, _ = jf.capture("Target finding A", "fact", verified_by="training-knowledge")
        new_id, _ = jf.capture("Successor finding B entirely different",
                               "fact", verified_by="training-knowledge", force_new=True)
        jf.supersede(new_id, old_id, reason="r")
        with self.assertRaises(RuntimeError) as cm:
            jf.purge(old_id, reason="should be refused — B still references it")
        self.assertIn("supersedes", str(cm.exception))

    def test_purge_succeeds_after_supersedes_link_removed(self):
        # Same setup, but now we purge B FIRST (which clears the active
        # supersedes link), then purging A should succeed.
        old_id, _ = jf.capture("Old claim Z", "fact", verified_by="training-knowledge")
        new_id, _ = jf.capture("New claim Z entirely separate", "fact",
                               verified_by="training-knowledge", force_new=True)
        jf.supersede(new_id, old_id, reason="r")
        # Purge B (active, with supersedes:[A]). This is allowed: nothing active
        # references B itself. Backref-cleanup will null A.superseded_by.
        ok = jf.purge(new_id, reason="cleanup")
        self.assertTrue(ok)
        # Now A (in superseded/) has no live referrer; purging it is fine.
        ok2 = jf.purge(old_id, reason="cleanup the orphan")
        self.assertTrue(ok2)


class TestQuery(FindingsTest):

    def test_query_returns_relevant(self):
        jf.capture("The quick brown fox jumps over lazy dog",
                   "fact", verified_by="training-knowledge")
        jf.capture("Pizza is best with extra cheese always",
                   "opinion", verified_by="training-knowledge")
        results = jf.query("brown fox")
        self.assertEqual(len(results), 1)
        self.assertIn("fox", results[0]["claim"])

    def test_query_filters_by_type(self):
        jf.capture("A fact about gravity", "fact", verified_by="training-knowledge")
        jf.capture("An opinion about gravity", "opinion", verified_by="training-knowledge")
        results = jf.query("gravity", type_="fact")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["type"], "fact")

    def test_query_excludes_demoted_by_default(self):
        old_id, _ = jf.capture("Old claim about X subject", "fact",
                               verified_by="training-knowledge")
        new_id, _ = jf.capture("New claim about X subject totally different words",
                               "fact", verified_by="training-knowledge", force_new=True)
        jf.supersede(new_id, old_id, reason="r")
        results = jf.query("subject")
        # Only the new one should surface by default
        ids = [r["id"] for r in results]
        self.assertIn(new_id, ids)
        self.assertNotIn(old_id, ids)
        # With include_demoted, both surface
        results_all = jf.query("subject", include_demoted=True)
        ids_all = [r["id"] for r in results_all]
        self.assertIn(old_id, ids_all)


class TestHookBlock(FindingsTest):
    """Tests for the rendering used by UserPromptSubmit and PreToolUse hooks."""

    def test_hook_returns_empty_for_no_match(self):
        out = jf.hook_finding_block("nothing in store yet about anything")
        self.assertEqual(out, "")

    def test_hook_jaccard_floor_filters_loose_matches(self):
        jf.capture(
            "Anthropic findings log architecture and design",
            "fact", verified_by="training-knowledge",
        )
        # Loose query — would match BM25 weakly but not Jaccard
        out_loose = jf.hook_finding_block("the design", min_jaccard=0.3)
        # Strict query that overlaps the claim
        out_tight = jf.hook_finding_block("findings log architecture", min_jaccard=0.10)
        self.assertEqual(out_loose, "", msg="loose query should be filtered by Jaccard")
        self.assertNotEqual(out_tight, "", msg="real overlap should pass")


def main() -> int:
    unittest.main(argv=sys.argv, verbosity=1, exit=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
