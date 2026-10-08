"""Actual fresh POSIX files/SQLite only; no App, network, provider or user DB."""
import hashlib,importlib.util,io,json,os,shutil,sqlite3,sys,tempfile,time,unittest
from pathlib import Path

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
files=load('files_helper','runtime-owned-files.py');physical=load('physical_helper','physical-goal-snapshot.py')

class FreshFiles(unittest.TestCase):
    def setUp(self):
        self.root=Path(tempfile.mkdtemp(prefix='eg-runtime-owned-files-',dir=str(Path(tempfile.gettempdir()).resolve())));self.root.chmod(0o700);self.profile=self.root/'profile';self.profile.mkdir(mode=0o700);self.leaf=self.profile/'result';self.leaf.write_text('synthetic\n');self.leaf.chmod(0o600)
    def tearDown(self): shutil.rmtree(self.root)
    def end(self): return time.monotonic_ns()+5_000_000_000
    def anchor(self): return files.directory(self.profile.stat())
    def test_actual_fingerprint_preserves_exact_inode_mtime_content(self):
        before=self.leaf.stat();a=files.fingerprint(str(self.leaf),str(self.root),self.end());after=self.leaf.stat();self.assertEqual(a['sha256'],hashlib.sha256(b'synthetic\n').hexdigest());self.assertEqual(a['ino'],str(before.st_ino));self.assertEqual(files.identity(before),files.identity(after))
    def test_actual_cleanup_owned_directory_and_empty_nested_directory(self):
        (self.profile/'nested').mkdir(mode=0o700);a=files.cleanup(str(self.profile),str(self.root),self.anchor(),self.end());self.assertTrue(a['removed']);self.assertEqual(a['files'],1);self.assertFalse(self.profile.exists());self.assertTrue(self.root.exists())
    def test_replaced_directory_anchor_is_preserved(self):
        anchor=self.anchor();old=self.root/'old';self.profile.rename(old);self.profile.mkdir(mode=0o700);(self.profile/'sentinel').write_text('preserved');
        with self.assertRaises(ValueError): files.cleanup(str(self.profile),str(self.root),anchor,self.end())
        self.assertEqual((self.profile/'sentinel').read_text(),'preserved');self.assertTrue(old.exists())
    def test_hardlinked_result_not_read_or_deleted(self):
        os.link(self.leaf,self.profile/'hard');
        with self.assertRaises(ValueError): files.fingerprint(str(self.leaf),str(self.root),self.end())
        with self.assertRaises(ValueError): files.cleanup(str(self.profile),str(self.root),self.anchor(),self.end())
        self.assertTrue(self.leaf.exists());self.assertTrue((self.profile/'hard').exists())
    def test_symlink_result_not_followed_or_deleted(self):
        self.leaf.unlink();self.leaf.symlink_to('/does-not-exist');
        with self.assertRaises(OSError): files.fingerprint(str(self.leaf),str(self.root),self.end())
        with self.assertRaises(ValueError): files.cleanup(str(self.profile),str(self.root),self.anchor(),self.end())
        self.assertTrue(self.leaf.is_symlink())
    def test_memory_basename_rejected_before_leaf_read(self):
        p=self.profile/'MEMORY.md';p.write_text('synthetic only');anchor=p.stat().st_ino;
        with self.assertRaises(ValueError): files.fingerprint(str(p),str(self.root),self.end())
        with self.assertRaises(ValueError): files.cleanup(str(self.profile),str(self.root),self.anchor(),self.end())
        self.assertEqual(p.stat().st_ino,anchor)
    def test_cannot_cleanup_controller_root(self):
        with self.assertRaises(ValueError): files.cleanup(str(self.root),str(self.root),files.directory(self.root.stat()),self.end())
        self.assertTrue(self.root.exists())
    def test_expired_deadline_does_not_delete_profile(self):
        with self.assertRaises(ValueError): files.cleanup(str(self.profile),str(self.root),self.anchor(),time.monotonic_ns()-1)
        self.assertTrue(self.profile.exists())

class FreshDiscovery(unittest.TestCase):
    def setUp(self):
        self.root=Path(tempfile.mkdtemp(prefix='eg-runtime-discovery-',dir=str(Path(tempfile.gettempdir()).resolve())));self.root.chmod(0o700);self.data=self.root/'eg-qa-appdata';self.data.mkdir(mode=0o700);self.db=self.data/'eastgenesis.db';self.c=sqlite3.connect(self.db);self.c.execute('PRAGMA journal_mode=WAL');self.c.execute('PRAGMA wal_autocheckpoint=0');self.c.executescript('CREATE TABLE goals(id TEXT,status TEXT,rounds TEXT,description TEXT,deleted_at INTEGER); CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE tool_invocations(idempotency_key TEXT,task_id TEXT,step_id TEXT,invocation_id TEXT,tool TEXT,args_digest TEXT,attempt INTEGER,state TEXT,artifacts TEXT,detail TEXT,lease_owner TEXT,lease_expires_at INTEGER,created_at INTEGER,updated_at INTEGER); CREATE INDEX tool_invocations_lease ON tool_invocations(lease_owner,lease_expires_at);');self.c.execute('INSERT INTO app_meta VALUES(?,?)',('schema_version','7'));self.add('goal-a','explicit synthetic description');self.c.commit()
    def tearDown(self): self.c.close();shutil.rmtree(self.root)
    def add(self,gid,description):
        self.c.execute('INSERT INTO goals VALUES(?,?,?,?,NULL)',(gid,'idle','{}',description));self.c.execute('INSERT INTO app_meta VALUES(?,?)',('goal-quota:v1:'+gid,'{}'))
    def read(self,description): return physical.read_goal(str(self.db),str(self.root),description,time.monotonic_ns()+5_000_000_000,True)
    def test_actual_uncheckpointed_wal_description_discovery(self):
        a=self.read('explicit synthetic description');self.assertEqual(a['canonical']['goalId'],'goal-a');self.assertTrue(a['sourceOpenedNoFollow']);self.assertFalse(a['authorizesResume']);self.assertEqual(list(self.root.glob('physical-snapshot-*')),[])
    def test_duplicate_description_rejected_without_guessing_goal(self):
        self.add('goal-b','explicit synthetic description');self.c.commit()
        with self.assertRaises(ValueError): self.read('explicit synthetic description')
        self.assertEqual(list(self.root.glob('physical-snapshot-*')),[])
    def test_description_is_bound_parameter_not_sql_expression(self):
        with self.assertRaises(ValueError): self.read("' OR 1=1 --")
        self.assertEqual(self.c.execute('SELECT count(*) FROM goals').fetchone()[0],1)
    def test_deleted_goal_does_not_enter_discovery(self):
        self.c.execute('UPDATE goals SET deleted_at=1');self.c.commit()
        with self.assertRaises(ValueError): self.read('explicit synthetic description')

if __name__=='__main__':
    stream=io.StringIO();suite=unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(FreshFiles),unittest.defaultTestLoader.loadTestsFromTestCase(FreshDiscovery)]);result=unittest.TextTestRunner(stream=stream,verbosity=2).run(suite);report={'kind':'runtime_actual_fresh_posix_files_sqlite','passed':result.wasSuccessful(),'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'host':sys.platform,'actualPosixFiles':True,'actualFreshSQLite':True,'linuxNativeExecuted':False,'appStarted':False,'listeners':0,'providerRequests':0,'fullGoalProven':False};print(json.dumps(report));sys.exit(0 if result.wasSuccessful() else 1)
