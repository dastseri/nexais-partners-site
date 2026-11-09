"""Regression tests for actual Jarvis CSV import contract (synthetic fixtures only in tests)."""
import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMPORTER = ROOT / "tools" / "import-sends.py"
HEADERS = ["تاریخ", "بخش", "طرف مکاتبه", "جهت", "خلاصه", "کانال / لینک", "وضعیت"]


class RealImportContractTests(unittest.TestCase):
    def test_reimport_is_idempotent_and_distinct_same_day_mail_is_retained(self):
        with tempfile.TemporaryDirectory(prefix="partners-import-test-") as tmp:
            root = Path(tmp)
            register = root / "original-register.csv"
            output = root / "private-sends.jsonl"
            rows = [
                ["2026-11-09", "NexAIS", "Terroni", "ارسال",
                 "پروپوزال اولیه برای Terroni", "ایمیل -> info@terroni.com", "ارسال شد"],
                ["2026-11-09", "NexAIS", "Terroni", "ارسال",
                 "پروپوزال اصلاح‌شده برای Terroni", "ایمیل -> info@terroni.com", "ارسال شد"],
                ["2026-11-09", "ZhioStudio", "A different company", "ارسال",
                 "پروپوزال", "ایمیل -> person@example.invalid", "ارسال شد"],
                ["2026-11-09", "NexAIS", "Terroni", "دریافت",
                 "جواب به ایمیل", "ایمیل", "پاسخ"],
            ]
            with register.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(HEADERS)
                writer.writerows(rows)
            cmd = [sys.executable, str(IMPORTER), "--csv", str(register),
                   "--out", str(output), "--index", str(ROOT / "index.html")]
            first = subprocess.run(cmd, text=True, capture_output=True, check=True)
            first_counts = json.loads(first.stdout)
            self.assertEqual(first_counts["added"], 2)
            self.assertEqual(first_counts["excluded_other_projects"], 1)
            self.assertEqual(first_counts["skipped"], 1)
            records = [json.loads(row) for row in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(records), 2)
            self.assertEqual(len({r["id"] for r in records}), 2)
            self.assertTrue(all(r["body_text"] == "" for r in records))
            self.assertTrue(all(r["subject"] == "" for r in records))
            self.assertTrue(all(r["sent_at"].endswith("-05:00") for r in records))
            second = subprocess.run(cmd, text=True, capture_output=True, check=True)
            second_counts = json.loads(second.stdout)
            self.assertEqual(second_counts["added"], 0)
            self.assertEqual(second_counts["duplicate"], 2)
            self.assertEqual(len(output.read_text(encoding="utf-8").splitlines()), 2)


if __name__ == "__main__":
    unittest.main()
