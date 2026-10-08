"""Actual fresh-file/SQLite evidence. No user DB, App, or Provider access."""
import argparse
import hashlib
import importlib.util
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

SOURCE = Path(__file__).with_name("physical-goal-snapshot.py")
spec = importlib.util.spec_from_file_location("physical_snapshot", SOURCE)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
GID = "goal-physical-fixture"


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        parent = str(Path(tempfile.gettempdir()).resolve())
        self.root = Path(tempfile.mkdtemp(prefix="eg-physical-fixture-", dir=parent))
        self.root.chmod(0o700)
        self.data = self.root / "eg-qa-appdata"
        self.data.mkdir(mode=0o700)
        self.db = self.data / "eastgenesis.db"
        self.connection = sqlite3.connect(self.db)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA wal_autocheckpoint=0")
        self.connection.executescript("""
        CREATE TABLE goals(id TEXT,status TEXT,rounds TEXT,deleted_at INTEGER);
        CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE tool_invocations(idempotency_key TEXT,task_id TEXT,step_id TEXT,invocation_id TEXT,tool TEXT,args_digest TEXT,attempt INTEGER,state TEXT,artifacts TEXT,detail TEXT,lease_owner TEXT,lease_expires_at INTEGER,created_at INTEGER,updated_at INTEGER);
        CREATE INDEX tool_invocations_lease ON tool_invocations(lease_owner,lease_expires_at);
        """)
        rounds = json.dumps({"execution": {"task_id": "task-fixture", "fence": 1}, "rounds": []})
        self.connection.execute("INSERT INTO goals VALUES(?,?,?,NULL)", (GID, "paused", rounds))
        self.connection.execute("INSERT INTO app_meta VALUES(?,?)", ("goal-quota:v1:" + GID, '{"consumed":3,"pending":0}'))
        self.connection.execute("INSERT INTO app_meta VALUES('schema_version','7')")
        self.connection.execute("INSERT INTO tool_invocations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                ("idem-fixture", "task-fixture", "step-fixture", "inv-fixture", "mcp__files__write_file",
                                 "synthetic-args", 1, "applied", "[]", "{}", None, 0, 1, 2))
        self.connection.commit()

    def tearDown(self):
        if self.connection is not None:
            self.connection.close()
        shutil.rmtree(self.root)
        self.assertFalse(self.root.exists())

    def read(self, gid=GID):
        return helper.read_goal(str(self.db), str(self.root), gid, time.monotonic_ns() + 5_000_000_000)

    def assert_copies_gone(self):
        self.assertEqual(list(self.root.glob("physical-snapshot-*")), [])

    def no_source_reads(self, action):
        original = helper.read_source
        reads = []
        def reject_read(*args):
            reads.append(True)
            raise AssertionError("unexpected_source_read")
        helper.read_source = reject_read
        try:
            with self.assertRaises((ValueError, OSError)):
                action()
            self.assertEqual(reads, [])
        finally:
            helper.read_source = original
        self.assert_copies_gone()

    def test_uncheckpointed_wal_contains_goal_and_ledger(self):
        before = {n: (self.data / n).read_bytes() for n in ("eastgenesis.db", "eastgenesis.db-wal")}
        result = self.read()
        self.assertEqual(result["canonical"]["goalId"], GID)
        self.assertEqual(json.loads(result["canonical"]["storedLedger"])[0]["state"], "applied")
        self.assertTrue(result["stableSourceCohortBeforeAfter"])
        self.assertFalse(result["sqliteOpenedSourceDirectly"])
        self.assertFalse(result["sourceShmRead"])
        self.assertFalse(result["authorizesResume"])
        self.assertEqual(before, {n: (self.data / n).read_bytes() for n in before})
        self.assert_copies_gone()

    def test_database_without_wal(self):
        self.connection.close(); self.connection = None
        self.assertFalse((self.data / "eastgenesis.db-wal").exists())
        result = self.read()
        self.assertIsNone(result["sourceCohort"]["eastgenesis.db-wal"])
        self.assertEqual(result["canonical"]["status"], "paused")
        self.assert_copies_gone()

    def test_database_symlink_rejects_before_bytes(self):
        self.connection.close(); self.connection = None
        actual = self.data / "actual.db"
        self.db.rename(actual); self.db.symlink_to(actual.name)
        self.no_source_reads(self.read)

    def test_wal_symlink_rejects_before_bytes(self):
        wal = self.data / "eastgenesis.db-wal"
        actual = self.data / "actual-wal"
        wal.rename(actual); wal.symlink_to(actual.name)
        self.no_source_reads(self.read)

    def test_database_hardlink_rejects_before_bytes(self):
        os.link(self.db, self.data / "db-hardlink")
        self.no_source_reads(self.read)

    def test_parent_symlink_rejects_before_bytes(self):
        moved = self.root / "actual-appdata"
        self.data.rename(moved); self.data.symlink_to(moved.name)
        self.no_source_reads(self.read)

    def test_unowned_permission_root_rejects_before_bytes(self):
        self.root.chmod(0o755)
        self.no_source_reads(self.read)
        self.root.chmod(0o700)

    def test_cohort_metadata_change_rejects_and_cleans(self):
        original = helper.read_source
        def change(item, end):
            value = original(item, end)
            row = self.db.stat()
            os.utime(self.db, ns=(row.st_atime_ns, row.st_mtime_ns + 1_000_000))
            return value
        helper.read_source = change
        try:
            with self.assertRaisesRegex(ValueError, "physical_source_cohort_changed"):
                self.read()
        finally:
            helper.read_source = original
        self.assert_copies_gone()

    def test_source_shm_is_not_opened_or_part_of_equality(self):
        first = self.read()
        self.connection.close(); self.connection = None
        target = self.root / "synthetic-unread.txt"
        target.write_text("synthetic source SHM is never read")
        source_shm = self.data / "eastgenesis.db-shm"
        source_shm.symlink_to(target)
        second = self.read()
        self.assertEqual(first["canonical"], second["canonical"])
        self.assertEqual(first["canonicalSha256"], second["canonicalSha256"])
        self.assertEqual(target.read_text(), "synthetic source SHM is never read")
        self.assert_copies_gone()

    def test_expired_deadline_rejects_before_bytes(self):
        self.no_source_reads(lambda: helper.read_goal(str(self.db), str(self.root), GID, time.monotonic_ns() - 1))

    def test_missing_goal_rejects_and_copy_is_removed(self):
        with self.assertRaisesRegex(ValueError, "physical_goal_not_unique"):
            self.read("goal-missing")
        self.assert_copies_gone()

    def test_duplicate_goal_rejects_and_copy_is_removed(self):
        self.connection.execute("INSERT INTO goals SELECT * FROM goals"); self.connection.commit()
        with self.assertRaisesRegex(ValueError, "physical_goal_not_unique"):
            self.read()
        self.assert_copies_gone()

    def test_sparse_oversize_database_rejects_before_bytes(self):
        self.connection.close(); self.connection = None
        with self.db.open("r+b") as f:
            f.truncate(helper.LIMIT + 1)
        self.no_source_reads(self.read)

    def test_schema_query_error_removes_copy(self):
        self.connection.execute("DROP TABLE tool_invocations"); self.connection.commit()
        with self.assertRaises(sqlite3.OperationalError):
            self.read()
        self.assert_copies_gone()

    def test_replaced_profile_directory_is_rejected(self):
        original = helper.read_source
        changed = False
        def replace(item, end):
            nonlocal changed
            value = original(item, end)
            if not changed:
                self.data.rename(self.root / "old-appdata")
                self.data.mkdir(mode=0o700)
                changed = True
            return value
        helper.read_source = replace
        try:
            with self.assertRaisesRegex(ValueError, "physical_profile_directory_changed"):
                self.read()
        finally:
            helper.read_source = original
        self.assert_copies_gone()

    def test_oversize_sqlite_cell_is_rejected_and_copy_removed(self):
        self.connection.execute("UPDATE goals SET rounds=?", ('{"large":"' + "x" * helper.OUTPUT_LIMIT + '"}',))
        self.connection.commit()
        with self.assertRaises(sqlite3.DataError):
            self.read()
        self.assert_copies_gone()

    def descriptor_count(self):
        return len(os.listdir("/dev/fd" if sys.platform == "darwin" else "/proc/self/fd"))

    def test_replaced_snapshot_directory_is_preserved_and_all_fds_closed(self):
        before = self.descriptor_count()
        original = helper.copy_file
        changed = False
        replacement = None
        def replace(directory, name, value, end):
            nonlocal changed, replacement
            original(directory, name, value, end)
            if not changed:
                replacement = next(self.root.glob("physical-snapshot-*"))
                replacement.rename(self.root / "renamed-owned-copy")
                replacement.mkdir(mode=0o700)
                changed = True
        helper.copy_file = replace
        try:
            with self.assertRaisesRegex(ValueError, "physical_copy_directory_changed"):
                self.read()
        finally:
            helper.copy_file = original
        self.assertTrue(replacement.is_dir())
        self.assertTrue((self.root / "renamed-owned-copy").is_dir())
        self.assertEqual(self.descriptor_count(), before)

    def test_unexpected_copy_entry_rejects_cleanup_and_all_fds_closed(self):
        before = self.descriptor_count()
        original = helper.copy_file
        changed = False
        def inject(directory, name, value, end):
            nonlocal changed
            original(directory, name, value, end)
            if not changed:
                fd = os.open("unexpected.txt", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400, dir_fd=directory)
                os.close(fd)
                changed = True
        helper.copy_file = inject
        try:
            with self.assertRaisesRegex(ValueError, "physical_copy_cleanup_unverified"):
                self.read()
        finally:
            helper.copy_file = original
        self.assertEqual(self.descriptor_count(), before)
        self.assertEqual(len(list(self.root.glob("physical-snapshot-*/unexpected.txt"))), 1)

    def test_snapshot_mkdir_collision_preserves_unbound_directory_and_all_fds_closed(self):
        before = self.descriptor_count()
        original = helper.os.mkdir
        collided = None
        identity = None
        def collision(name, mode=0o777, *, dir_fd=None):
            nonlocal collided, identity
            if isinstance(name, str) and name.startswith("physical-snapshot-") and dir_fd is not None:
                # Create an actual empty conflicting directory; the second
                # mkdir raises the OS FileExistsError before a held copy FD.
                original(name, mode=mode, dir_fd=dir_fd)
                collided = self.root / name
                row = collided.stat()
                identity = (row.st_dev, row.st_ino)
            return original(name, mode=mode, dir_fd=dir_fd)
        helper.os.mkdir = collision
        try:
            with self.assertRaises(FileExistsError):
                self.read()
        finally:
            helper.os.mkdir = original
        self.assertIsNotNone(collided)
        self.assertTrue(collided.is_dir())
        row = collided.stat()
        self.assertEqual((row.st_dev, row.st_ino), identity)
        self.assertEqual(list(collided.iterdir()), [])
        self.assertEqual(self.descriptor_count(), before)

    def test_snapshot_open_failure_preserves_unbound_directory_and_all_fds_closed(self):
        self.assertNotEqual(os.geteuid(), 0, "actual permission denial requires an unprivileged test host")
        before = self.descriptor_count()
        original = helper.os.open
        denied = None
        identity = None
        def deny(name, flags, mode=0o777, *, dir_fd=None):
            nonlocal denied, identity
            if isinstance(name, str) and name.startswith("physical-snapshot-") and dir_fd is not None:
                # mkdir succeeds, then a real mode000 directory causes the
                # nofollow open to fail before snapshot_fd can be assigned.
                denied = self.root / name
                denied.chmod(0o000)
                row = denied.stat()
                identity = (row.st_dev, row.st_ino)
            return original(name, flags, mode, dir_fd=dir_fd)
        helper.os.open = deny
        try:
            with self.assertRaises(PermissionError):
                self.read()
        finally:
            helper.os.open = original
            if denied is not None and denied.exists():
                denied.chmod(0o700)
        self.assertIsNotNone(denied)
        self.assertTrue(denied.is_dir())
        row = denied.stat()
        self.assertEqual((row.st_dev, row.st_ino), identity)
        self.assertEqual(list(denied.iterdir()), [])
        self.assertEqual(self.descriptor_count(), before)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    helper.host()
    output = Path(args.output)
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(SnapshotTests))
    report = dict(kind="physical_goal_nofollow_snapshot_actual_fresh_files", passed=result.wasSuccessful(),
                  tests=result.testsRun, failed=len(result.failures), errors=len(result.errors),
                  sourceSha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                  actualSyntheticSqliteFiles=True, appOrDriverLaunched=False, currentUserDatabaseRead=False,
                  providerRequests=0, fullGoalProven=False, appProfileBindingStillRequired=True)
    # Do not publish tracebacks or arbitrary SQLite content on failure.
    with output.open("x") as f:
        json.dump(report, f, indent=2); f.write("\n")
    output.chmod(0o400)
    print(json.dumps(report))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
