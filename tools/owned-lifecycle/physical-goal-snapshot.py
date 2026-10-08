"""Bounded POSIX Goal evidence from stable nofollow DB/WAL file handles.

This helper does not authorize resume. Its caller must bind the fresh profile
to the actual owned App. SQLite opens only a private copy of a stable source
cohort. Source SHM identities are not part of canonical Task equality.
"""
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import time

LIMIT = 32 * 1024 * 1024
OUTPUT_LIMIT = 131072
SQL = """WITH g AS (SELECT id,status,rounds FROM goals WHERE id=? AND deleted_at IS NULL),
l AS (SELECT t.* FROM tool_invocations t WHERE t.task_id=(SELECT json_extract(rounds,'$.execution.task_id') FROM g) ORDER BY t.idempotency_key)
SELECT g.id,g.status,g.rounds,
(SELECT value FROM app_meta WHERE key='goal-quota:v1:'||g.id),
(SELECT value FROM app_meta WHERE key='schema_version'),
(SELECT count(*) FROM sqlite_master WHERE type='index' AND name='tool_invocations_lease' AND tbl_name='tool_invocations'),
(SELECT json_group_array(json_object('idempotency_key',idempotency_key,'task_id',task_id,'step_id',step_id,'invocation_id',invocation_id,'tool',tool,'args_digest',args_digest,'attempt',attempt,'state',state,'artifacts',artifacts,'detail',detail,'lease_owner',lease_owner,'lease_expires_at',lease_expires_at,'created_at',created_at,'updated_at',updated_at)) FROM l) FROM g"""


def need(value, code):
    if not value:
        raise ValueError(code)


def host():
    need(os.name == "posix" and sys.platform in ("linux", "darwin"), "physical_platform_unsupported")


def check_deadline(end):
    need(time.monotonic_ns() < end, "physical_deadline_exceeded")


def parts(path):
    need(isinstance(path, str) and path.startswith("/") and "\0" not in path, "physical_absolute")
    result = path.split("/")[1:]
    need(result and all(x not in ("", ".", "..") for x in result), "physical_path_invalid")
    need(all(x.lower() != "memory.md" for x in result), "physical_memory_prohibited")
    return result


def dir_open(path_parts, end, owned_from):
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for i, name in enumerate(path_parts):
            check_deadline(end)
            nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
            row = os.fstat(fd)
            need(stat.S_ISDIR(row.st_mode), "physical_not_directory")
            if i >= owned_from:
                need(row.st_uid == os.getuid() and stat.S_IMODE(row.st_mode) == 0o700, "physical_directory_not_owned")
        return fd
    except BaseException:
        os.close(fd)
        raise


def identity(row):
    return (row.st_dev, row.st_ino, row.st_uid, row.st_mode, row.st_nlink,
            row.st_size, row.st_mtime_ns, row.st_ctime_ns)


def directory_identity(row):
    return (row.st_dev, row.st_ino, row.st_uid, row.st_mode)


def check_directories(root_parts, db_parts, root_fd, source_fd, end):
    for path_parts, held in ((root_parts, root_fd), (db_parts[:-1], source_fd)):
        current = dir_open(path_parts, end, len(root_parts) - 1)
        try:
            need(directory_identity(os.fstat(current)) == directory_identity(os.fstat(held)),
                 "physical_profile_directory_changed")
        finally:
            os.close(current)


def file_open(directory, name, optional, end):
    check_deadline(end)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    except FileNotFoundError:
        need(optional, "physical_database_missing")
        return None
    try:
        row = os.fstat(fd)
        need(stat.S_ISREG(row.st_mode) and row.st_uid == os.getuid() and row.st_nlink == 1
             and 0 <= row.st_size <= LIMIT, "physical_source_not_regular_owned")
        need(identity(row) == identity(os.stat(name, dir_fd=directory, follow_symlinks=False)), "physical_path_identity_changed")
        return {"fd": fd, "before": row, "name": name}
    except BaseException:
        os.close(fd)
        raise


def read_source(item, end):
    chunks = []
    remaining = item["before"].st_size
    while remaining:
        check_deadline(end)
        chunk = os.read(item["fd"], min(65536, remaining))
        need(chunk, "physical_short_read")
        chunks.append(chunk)
        remaining -= len(chunk)
    need(os.read(item["fd"], 1) == b"", "physical_source_grew")
    return b"".join(chunks)


def check_sources(directory, items, end):
    for name, item in items.items():
        check_deadline(end)
        if item is None:
            try:
                os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise ValueError("physical_source_cohort_changed")
        need(identity(item["before"]) == identity(os.fstat(item["fd"]))
             == identity(os.stat(name, dir_fd=directory, follow_symlinks=False)), "physical_source_cohort_changed")


def copy_file(directory, name, value, end):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400, dir_fd=directory)
    try:
        offset = 0
        while offset < len(value):
            check_deadline(end)
            count = os.write(fd, value[offset:offset + 65536])
            need(count > 0, "physical_copy_incomplete")
            offset += count
        os.fsync(fd)
    finally:
        os.close(fd)


def read_goal(db_path, owned_root, goal_id, end, by_description=False):
    host()  # Before inspecting arguments, source paths, SQLite, or a profile.
    need(isinstance(end, int) and time.monotonic_ns() < end <= time.monotonic_ns() + 10_000_000_000,
         "physical_budget_invalid")
    need(isinstance(goal_id, str) and ((by_description and 1 <= len(goal_id) <= 2000 and chr(0) not in goal_id) or (not by_description and re.fullmatch(r"goal-[a-z0-9][a-z0-9-]{0,47}", goal_id))), "physical_goal_id")
    root_parts, db_parts = parts(owned_root), parts(db_path)
    need(db_parts[:len(root_parts)] == root_parts and len(db_parts) > len(root_parts) + 1
         and "eg-qa-appdata" in db_parts[len(root_parts):-1] and db_parts[-1] == "eastgenesis.db", "physical_wrong_database")
    root_fd = source_dir = snapshot_fd = saved_cwd = None
    snapshot_name = None
    items = {}
    try:
        root_fd = dir_open(root_parts, end, len(root_parts) - 1)
        source_dir = dir_open(db_parts[:-1], end, len(root_parts) - 1)
        items["eastgenesis.db"] = file_open(source_dir, "eastgenesis.db", False, end)
        items["eastgenesis.db-wal"] = file_open(source_dir, "eastgenesis.db-wal", True, end)
        cohort = {name: read_source(item, end) if item is not None else None for name, item in items.items()}
        check_sources(source_dir, items, end)
        check_directories(root_parts, db_parts, root_fd, source_dir, end)
        snapshot_name = "physical-snapshot-" + os.urandom(16).hex()
        os.mkdir(snapshot_name, mode=0o700, dir_fd=root_fd)
        snapshot_fd = os.open(snapshot_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        for name, value in cohort.items():
            if value is not None:
                copy_file(snapshot_fd, name, value, end)
        # A dedicated helper process changes CWD to its held directory. The
        # SQLite URI cannot resolve through a replaced source/root pathname.
        saved_cwd = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
        os.fchdir(snapshot_fd)
        connection = sqlite3.connect("file:eastgenesis.db?mode=ro", uri=True, timeout=0.1)
        try:
            connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, OUTPUT_LIMIT)
            connection.set_progress_handler(lambda: int(time.monotonic_ns() >= end), 100)
            connection.execute("PRAGMA query_only=ON")
            need(connection.execute("PRAGMA query_only").fetchone() == (1,), "physical_not_query_only")
            connection.execute("BEGIN")
            query = SQL.replace("WHERE id=? AND deleted_at IS NULL", "WHERE description=? AND deleted_at IS NULL") if by_description else SQL
            rows = connection.execute(query, (goal_id,)).fetchall()
            need(len(rows) == 1, "physical_goal_not_unique")
            row = rows[0]
            need((by_description and re.fullmatch(r"goal-[a-z0-9][a-z0-9-]{0,47}", row[0]) or not by_description and row[0] == goal_id) and row[4] == "7" and row[5] == 1
                 and all(isinstance(row[i], str) for i in (0, 1, 2, 3, 4, 6)), "physical_schema_or_shape")
            canonical = dict(goalId=row[0], status=row[1], storedRounds=row[2], storedAuthority=row[3],
                             schemaVersion=row[4], leaseIndex=row[5], storedLedger=row[6])
            for name in ("storedRounds", "storedAuthority", "storedLedger"):
                json.loads(canonical[name])
            body = json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode()
            need(len(body) <= OUTPUT_LIMIT, "physical_output_limit")
            connection.rollback()
        finally:
            connection.close()
            os.fchdir(saved_cwd)
        check_sources(source_dir, items, end)
        check_directories(root_parts, db_parts, root_fd, source_dir, end)
        bindings = {name: {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
                    if value is not None else None for name, value in cohort.items()}
        result = dict(canonical=canonical, canonicalSha256=hashlib.sha256(body).hexdigest(),
                      sourceCohort=bindings, sourceOpenedNoFollow=True, stableSourceCohortBeforeAfter=True,
                      sqlReadOnly=True, sqliteOpenedSourceDirectly=False, filesystemZeroWritesClaimed=False,
                      sourceShmRead=False, authorizesResume=False, appProfileBindingByCallerRequired=True,
                      sourceDirectoryIdentity=list(directory_identity(os.fstat(source_dir))),
                      ownedRootIdentity=list(directory_identity(os.fstat(root_fd))), snapshotCopyRemoved=True)
        need(len(json.dumps(result, ensure_ascii=False).encode()) <= OUTPUT_LIMIT, "physical_output_limit")
        return result
    finally:
        cleanup_error = None
        try:
            if saved_cwd is not None:
                os.fchdir(saved_cwd)
            if snapshot_fd is not None:
                anchor = directory_identity(os.fstat(snapshot_fd))
                need(directory_identity(os.stat(snapshot_name, dir_fd=root_fd, follow_symlinks=False)) == anchor,
                     "physical_copy_directory_changed")
                # Only known copy artifacts are removable. Unexpected entries
                # fail cleanup without recursively deleting an unverified path.
                for name in ("eastgenesis.db", "eastgenesis.db-wal", "eastgenesis.db-shm"):
                    try:
                        row = os.stat(name, dir_fd=snapshot_fd, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    need(stat.S_ISREG(row.st_mode) and row.st_uid == os.getuid() and row.st_nlink == 1,
                         "physical_copy_cleanup_unverified")
                    os.unlink(name, dir_fd=snapshot_fd)
                need(not os.listdir(snapshot_fd), "physical_copy_cleanup_unverified")
                need(directory_identity(os.stat(snapshot_name, dir_fd=root_fd, follow_symlinks=False)) == anchor,
                     "physical_copy_directory_changed")
            # mkdir/open rejection leaves no held identity for this name.
            # Preserve the unbound path instead of deleting a collision or
            # replacement directory. The original operation still rejects.
            if snapshot_fd is not None:
                os.rmdir(snapshot_name, dir_fd=root_fd)
        except BaseException as error:
            cleanup_error = error
        finally:
            # A rejected cleanup still closes every held descriptor. A named
            # directory replacement is preserved for explicit caller cleanup.
            for fd in [saved_cwd, snapshot_fd, *[item["fd"] for item in items.values() if item is not None],
                       source_dir, root_fd]:
                if fd is not None:
                    try:
                        os.close(fd)
                    except BaseException as error:
                        if cleanup_error is None:
                            cleanup_error = error
        if cleanup_error is not None:
            raise cleanup_error


def main():
    host()
    by_description = len(sys.argv) == 6 and sys.argv[1] == "--description"
    need(len(sys.argv) == 5 or by_description, "physical_arguments")
    args = sys.argv[2:] if by_description else sys.argv[1:]
    result = read_goal(args[0], args[1], args[2], int(args[3]), by_description)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Public artifacts receive fixed codes only, never arbitrary exceptions
        # containing source paths or SQLite content.
        print('{"passed":false,"code":"physical_snapshot_rejected"}')
        sys.exit(1)
