"""Pure/injected proc policies only; never native Linux process proof."""
import importlib.util,json,sys,unittest
from pathlib import Path
ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('runtime_identity_policy',ROOT/'linux-identity-helper.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
spec2=importlib.util.spec_from_file_location('runtime_supervisor_policy',ROOT/'linux-owned-supervisor.py');sup=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(sup)
INHERITED={'PATH':'/usr/bin:/bin','HOME':'/fresh/home','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','TMPDIR':'/fresh/tmp','XDG_CONFIG_HOME':'/fresh/config','XDG_DATA_HOME':'/fresh/data','XDG_CACHE_HOME':'/fresh/cache','XDG_RUNTIME_DIR':'/fresh/runtime','EASTGENESIS_QA_ISOLATED_PROFILE':'1'}
ADDITIONS={'TAURI_AUTOMATION':'true','TAURI_WEBVIEW_AUTOMATION':'true'}
def app_env():return dict(INHERITED,**ADDITIONS,WEBKIT_INSPECTOR_SERVER='127.0.0.1:32768',GTK_OVERLAY_SCROLLING='0')
def proc(pid,parent=50,ticks=10):
    f=['S',str(parent),'50','50']+['0']*15+[str(ticks)]+['0']*2
    return '%d (synthetic worker) %s'%(pid,' '.join(f))
def status(pid,tgid,uid=1000):return 'Pid:\t%d\nTgid:\t%d\nUid:\t%d\t%d\t%d\t%d\n'%(pid,tgid,uid,uid,uid,uid)
def proc_fixture():
    data={}
    for tid in (100,101):
        p='/proc/100/task/%d'%tid;data[p+'/stat']=proc(tid);data[p+'/status']=status(tid,100);data[p+'/children']='200' if tid==101 else ''
    data['/proc/200/stat']=proc(200,100,20);data['/proc/200/status']=status(200,200)
    return data
class Policies(unittest.TestCase):
    def rejected(self,fn,code):
        with self.assertRaises(base.GuardError) as caught:fn()
        self.assertEqual(str(caught.exception),code)
    def collect(self,data=None,lister=None,parent=None):
        data=data or proc_fixture();anchor=dict(pid=100,parentPid=50,pgid=50,sid=50,startTicks='10',uid=1000)
        return base.collect_thread_children(lambda p,n:data[p],lister or (lambda p:['100','101']),parent or (lambda:dict(anchor)),100,1000,lambda:None)
    def test_exact_app_safe_values(self):
        evidence=base.validate_descendant_environment(app_env(),INHERITED,ADDITIONS,'native_spawned_app')
        self.assertEqual(evidence,{'environmentKind':'native_spawned_app','inspectorServer':'127.0.0.1:32768','inspectorPort':32768,'gtkOverlayScrolling':'0'})
    def test_overlay_one_accepted(self):
        e=app_env();e['GTK_OVERLAY_SCROLLING']='1';self.assertEqual(base.validate_descendant_environment(e,INHERITED,ADDITIONS,'native_spawned_app')['gtkOverlayScrolling'],'1')
    def test_app_extras_never_inherited(self):self.rejected(lambda:base.validate_descendant_environment(app_env(),INHERITED,ADDITIONS,'inherited'),'inherited_environment_mismatch')
    def test_third_extra_rejected(self):
        e=app_env();e['UNKNOWN']='safe-looking';self.rejected(lambda:base.validate_descendant_environment(e,INHERITED,ADDITIONS,'native_spawned_app'),'native_app_environment_keys')
    def test_inspector_address_ports(self):
        for v in ['0.0.0.0:32768','localhost:32768','[::1]:32768','192.0.2.1:32768','127.0.0.1:032768','127.0.0.1:65536','127.0.0.1:1','127.0.0.1:32768/path']:
            e=app_env();e['WEBKIT_INSPECTOR_SERVER']=v;self.rejected(lambda:base.validate_descendant_environment(e,INHERITED,ADDITIONS,'native_spawned_app'),'native_app_inspector_invalid')
    def test_overlay_invalid(self):
        e=app_env();e['GTK_OVERLAY_SCROLLING']='true';self.rejected(lambda:base.validate_descendant_environment(e,INHERITED,ADDITIONS,'native_spawned_app'),'native_app_gtk_overlay_invalid')
    def test_missing_app_key(self):
        e=app_env();del e['GTK_OVERLAY_SCROLLING'];self.rejected(lambda:base.validate_descendant_environment(e,INHERITED,ADDITIONS,'native_spawned_app'),'native_app_environment_keys')
    def test_inherited_value_drift(self):
        e=app_env();e['HOME']='/another/home';self.rejected(lambda:base.validate_descendant_environment(e,INHERITED,ADDITIONS,'native_spawned_app'),'inherited_environment_mismatch')
    def test_both_automation_required(self):self.rejected(lambda:base.validate_descendant_environment(app_env(),INHERITED,{},'native_spawned_app'),'native_app_automation_required')
    def test_mcp_exact_five_keys_only(self):
        value={k:INHERITED[k] for k in ('PATH','HOME','LANG','LC_ALL','TMPDIR')};base.validate_descendant_environment(value,INHERITED,{},'mcp_builtin');value['WEBKIT_INSPECTOR_SERVER']='127.0.0.1:32768';self.rejected(lambda:base.validate_descendant_environment(value,INHERITED,{},'mcp_builtin'),'inherited_environment_mismatch')
    def test_parent_thread_worker_child_discovered(self):self.assertEqual(self.collect(),[200])
    def test_cross_thread_children_deduplicated(self):
        data=proc_fixture();data['/proc/100/task/100/children']='200';self.assertEqual(self.collect(data),[200])
    def test_duplicate_within_one_thread_rejected(self):
        data=proc_fixture();data['/proc/100/task/101/children']='200 200';self.rejected(lambda:self.collect(data),'children_invalid')
    def test_thread_wrong_tgid_rejected(self):
        data=proc_fixture();data['/proc/100/task/101/status']=status(101,999);self.rejected(lambda:self.collect(data),'task_identity_mismatch')
    def test_thread_uid_rejected(self):
        data=proc_fixture();data['/proc/100/task/101/status']=status(101,100,999);self.rejected(lambda:self.collect(data),'task_identity_mismatch')
    def test_child_wrong_parent_rejected(self):
        data=proc_fixture();data['/proc/200/stat']=proc(200,999,20);self.rejected(lambda:self.collect(data),'child_ancestry_raced')
    def test_parent_birth_change_rejected(self):
        anchor=dict(pid=100,parentPid=50,pgid=50,sid=50,startTicks='10',uid=1000);calls=0
        def parent():
            nonlocal calls;calls+=1;return dict(anchor,startTicks='11' if calls>1 else '10')
        self.rejected(lambda:self.collect(parent=parent),'parent_threads_raced')
    def test_thread_list_race_rejected(self):
        calls=0
        def names(path):
            nonlocal calls;calls+=1;return ['100','101'] if calls==1 else ['100']
        self.rejected(lambda:self.collect(lister=names),'parent_threads_raced')
    def test_thread_count_and_main_tid_required(self):
        for names in [list(map(str,range(100,357))),['101'],['100','100']]:self.rejected(lambda:self.collect(lister=lambda p:names),'task_list_invalid')
    def test_unknown_pid_rejects_before_proc(self):
        value=sup.Supervisor.__new__(sup.Supervisor);value.entries={};value.pending={};value.held={};value._read=lambda *_:self.fail('proc touched')
        with self.assertRaises(sup.GuardError) as caught:value._raw_children(999)
        self.assertEqual(str(caught.exception),'pid_unregistered')
    def test_pinned_dynamic_environment_cannot_change(self):
        value=sup.Supervisor.__new__(sup.Supervisor);value.environment=dict(INHERITED);value._read_environment=lambda _:dict(app_env(),WEBKIT_INSPECTOR_SERVER='127.0.0.1:32769')
        with self.assertRaises(sup.GuardError) as caught:value._environment(123,app_env(),'native_spawned_app')
        self.assertEqual(str(caught.exception),'inherited_environment_mismatch')
    def test_generic_supervisor_environment_rejects_webkit(self):
        value=sup.Supervisor.__new__(sup.Supervisor);value._read_environment=lambda _:app_env()
        with self.assertRaises(sup.GuardError) as caught:value._environment(123,None)
        self.assertEqual(str(caught.exception),'inherited_environment_not_fresh')
if __name__=='__main__':
    result=unittest.TextTestRunner(stream=sys.stderr).run(unittest.defaultTestLoader.loadTestsFromTestCase(Policies))
    print(json.dumps({'kind':'injected_linux_process_policies_v2','passed':result.wasSuccessful(),'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'actualProcRead':False,'linuxNativeExecuted':False,'listeners':0,'appSessions':0,'realProviderRequests':0,'fullGoalProven':False}))
    sys.exit(0 if result.wasSuccessful() else 1)
