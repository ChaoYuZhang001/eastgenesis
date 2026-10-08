#!/usr/bin/env python3
"""Exact pidfd process launcher. No App/HTTP/provider operations; inert import.

A newly born process waits on a private gate. Its Popen/pidfd birth capability
survives rejected target metadata and authorizes cleanup only. Descendants must
be pinned while their controlled parent lives, then adopted after that parent's
observed kernel exit. Signals are always journaled/fsynced first, never by PID
name or process group. All deadlines use the controller's CLOCK_MONOTONIC ns.
"""
import ctypes, hashlib, importlib.util, json, os, re, select, signal, stat, subprocess, sys, time
from pathlib import Path

BASE = Path(__file__).with_name('linux-identity-helper.py')
spec = importlib.util.spec_from_file_location('owned_identity_base', BASE)
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
GuardError, need, positive = base.GuardError, base.need, base.positive

def sha(value): return hashlib.sha256(value).hexdigest()
def compact(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
def prctl(option, arg):
    libc=ctypes.CDLL(None,use_errno=True)
    need(libc.prctl(option,arg,0,0,0)==0,'prctl_unavailable')

class Supervisor(base.LinuxAuthority):
    def __init__(self, owner, origin_ns, hard_end_ns, cleanup_ms, root, journal_path, python_spec):
        need(sys.platform.startswith('linux'),'platform_unsupported')
        now=time.monotonic_ns()
        need(isinstance(origin_ns,int) and isinstance(hard_end_ns,int) and origin_ns <= now < hard_end_ns and 10000_000_000 <= hard_end_ns-origin_ns <= 300000_000_000,'deadline_invalid')
        need(2000 <= cleanup_ms <= 10000,'cleanup_reserve_invalid')
        self.origin_ns=origin_ns; self.hard_end_ns=hard_end_ns; self.active_end_ns=hard_end_ns-cleanup_ms*1000000
        self.cleaning=False; self.cleanup_done=False; self.journal_fd=None; self.journal_anchor=None
        self.entries={}; self.roles={}; self.pending={}; self.attempted_roles=set(); self.sequence=0
        self.root=root; self.python_spec=python_spec; self.environment=dict(os.environ)
        need(set(self.environment) <= base.ENV_KEYS and self.environment.get('EASTGENESIS_QA_ISOLATED_PROFILE')=='1','environment_not_fresh')
        self._directory(root, owned=True)
        for key in ('HOME','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR'):
            need(self.environment.get(key,'').startswith(root+'/'),'environment_outside_owned_root'); self._directory(self.environment[key],owned=True)
        need(not os.path.lexists(self.environment['HOME']+'/Downloads'),'fresh_downloads_must_be_absent')
        # Register subreaper before any owned child can be born.
        prctl(36,1)
        state=ctypes.c_int(); libc=ctypes.CDLL(None,use_errno=True)
        need(libc.prctl(37,ctypes.byref(state),0,0,0)==0 and state.value==1,'subreaper_unverified')
        super().__init__(owner,max(10000,int((hard_end_ns-now)/1000000)))
        self._environment(self.owner['pid'],None)
        self._environment(os.getpid(),self.environment)
        actual=self._exe_file(python_spec['path']); need(actual['sha256']==python_spec['sha256'],'python_hash_mismatch')
        need(self.self_row['exe']['path']==python_spec['path'] and self.self_row['exe']['sha256']==python_spec['sha256'],'helper_executable_mismatch')
        need(journal_path.startswith(root+'/'),'journal_outside_owned_root'); self._directory(os.path.dirname(journal_path),owned=True)
        self.journal_fd=os.open(journal_path,os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        self.journal_anchor=os.fstat(self.journal_fd)
        self._journal('supervisor_ready',subreaper=True)
    def check(self):
        end=self.hard_end_ns if self.cleaning else self.active_end_ns
        need(time.monotonic_ns()<end,'cleanup_deadline_exceeded' if self.cleaning else 'global_deadline_exceeded')
    def _exe_file(self,path,executable=True):
        need(isinstance(path,str) and os.path.basename(path).casefold()!='memory.md','input_path_forbidden')
        return super()._exe_file(path,executable)
    def _directory(self,path,owned=False):
        need(isinstance(path,str) and path.startswith('/') and all(x not in ('','..','.') for x in path.split('/')[1:]),'directory_invalid')
        fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
        try:
            for part in path.split('/')[1:]:
                n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=n
            row=os.fstat(fd); need(stat.S_ISDIR(row.st_mode) and (not owned or row.st_uid==os.getuid() and row.st_mode&0o777==0o700),'directory_not_owned')
        finally: os.close(fd)
    def _environment(self,pid,expected):
        self.check()
        with open('/proc/%d/environ'%pid,'rb') as f: raw=f.read(131073)
        need(len(raw)<=131072,'environment_too_large')
        pairs=raw.rstrip(b'\0').split(b'\0'); value={}
        for pair in pairs:
            key,sep,data=pair.partition(b'='); need(sep and key.decode() not in value,'environment_invalid'); value[key.decode()]=data.decode()
        need(set(value)<=base.ENV_KEYS | {'TAURI_AUTOMATION','TAURI_WEBVIEW_AUTOMATION'},'inherited_environment_not_fresh')
        if expected is not None: need(value==expected,'inherited_environment_mismatch')
    def _journal(self,event,**fields):
        self.check(); need(self.journal_fd is not None,'journal_unavailable')
        a=os.fstat(self.journal_fd); b=self.journal_anchor
        need(stat.S_ISREG(a.st_mode) and a.st_uid==os.getuid() and a.st_nlink==1 and a.st_mode&0o777==0o600 and (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino),'journal_identity_changed')
        self.sequence+=1; row=dict(sequence=self.sequence,atNs=str(time.monotonic_ns()),event=event,**fields)
        data=compact(row)+b'\n'; need(len(data)<=8192,'journal_row_too_large')
        offset=0
        while offset<len(data):
            count=os.write(self.journal_fd,data[offset:]); need(count>0,'journal_write_incomplete'); offset+=count
        os.fsync(self.journal_fd); self.check(); return row
    def _exited(self,pid):
        need(pid in self.entries or pid in self.pending,'pid_unregistered')
        item=self.entries.get(pid) or self.pending[pid]
        return bool(select.select([item['handle']],[],[],0)[0])
    def _raw_children(self,pid):
        text=self._read('/proc/%d/task/%d/children'%(pid,pid),8192)
        ids=text.split(); need(len(ids)<=64 and len(ids)==len(set(ids)) and all(x.isdigit() and positive(int(x)) for x in ids),'children_invalid')
        return list(map(int,ids))
    def verify(self,pid):
        if pid not in self.entries: return super().verify(pid)
        item=self.entries[pid]; row=self._snapshot(pid,item['handle'])
        need(row==item['row'],'process_identity_changed')
        self._environment(pid,item['environment'])
        if item.get('argvHash') is not None:
            with open('/proc/%d/cmdline'%pid,'rb') as f: argv=f.read(262145)
            need(len(argv)<=262144 and sha(argv)==item['argvHash'],'inherited_argv_changed')
        if item.get('cwd') is not None: need(os.readlink('/proc/%d/cwd'%pid)==item['cwd'],'inherited_cwd_changed')
        return row
    def _wait_ready(self,fd,limit_ns):
        data=b''
        while not data.endswith(b'\n'):
            self.check(); need(time.monotonic_ns()<limit_ns,'birth_ready_timeout')
            if select.select([fd],[],[],min(.02,(limit_ns-time.monotonic_ns())/1e9))[0]:
                piece=os.read(fd,128); need(piece,'birth_gate_aborted'); data+=piece; need(len(data)<=128,'birth_ready_invalid')
        return data
    def spawn_owned(self,role,executable,args,env,cwd,check_target=True):
        self.check(); need(len(self.entries)+len(self.pending)<64,'owned_process_limit_exceeded'); need(isinstance(role,str) and re.fullmatch('[a-z][a-z0-9_-]{0,63}',role) and role not in self.roles and role not in self.attempted_roles,'role_invalid')
        need(isinstance(args,list) and len(args)<=64 and all(isinstance(x,str) and '\0' not in x and len(x)<=4096 for x in args),'argv_invalid')
        need(env==self.environment,'launch_environment_mismatch'); need(cwd.startswith(self.root+'/'),'cwd_outside_owned_root'); self._directory(cwd,owned=True)
        expected=self._exe_file(executable['path']); need(expected['sha256']==executable['sha256'],'target_hash_mismatch')
        self.attempted_roles.add(role)
        self._journal('launch_prepared',role=role,executableHash=expected['sha256'],argvHash=sha(compact([executable['path'],*args])),envHash=sha(compact(env)),cwdHash=sha(cwd.encode()))
        gate_r,gate_w=os.pipe2(os.O_CLOEXEC); ready_r,ready_w=os.pipe2(os.O_CLOEXEC)
        popen=None; handle=None; item=None
        try:
            bootargs=[self.python_spec['path'],'-I','-B','-u',os.path.abspath(__file__),'--birth',str(gate_r),str(ready_w),str(os.getpid())]
            popen=subprocess.Popen(bootargs,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=env,cwd=cwd,pass_fds=(gate_r,ready_w),close_fds=True)
            os.close(gate_r); gate_r=None; os.close(ready_w); ready_w=None
            # Retain the birth Popen immediately; a missing pidfd closes gate and
            # waits the exact Popen, never signaling a raw PID.
            item=dict(pid=popen.pid,popen=popen,handle=None,role=role,environment=dict(env),gate=gate_w,reaped=False)
            self.pending[popen.pid]=item
            handle=os.pidfd_open(popen.pid,0); item['handle']=handle
            ready=self._wait_ready(ready_r,min(self.active_end_ns,time.monotonic_ns()+5000_000_000))
            need(ready==('%d\n'%popen.pid).encode(),'birth_ready_invalid')
            row=self._snapshot(popen.pid,handle)
            need(row['parentPid']==os.getpid() and row['exe']['path']==self.python_spec['path'] and row['exe']['sha256']==self.python_spec['sha256'],'birth_identity_invalid')
            self._environment(popen.pid,env)
            item.update(row=row,birthRow=dict(row),birthParentStartTicks=self.self_row['startTicks'],proof='cleanup_only')
            self._journal('birth_pinned',role=role,pid=popen.pid,startTicks=row['startTicks'],parentPid=row['parentPid'],cleanupOnly=True)
            # Durable ownership exists before release into arbitrary target exec.
            self._journal('gate_release_prepared',role=role,pid=popen.pid,startTicks=row['startTicks'])
            command=compact(dict(executable=executable['path'],args=args,env=env,cwd=cwd))+b'\n'
            need(len(command)<=65536,'birth_command_too_large'); offset=0
            while offset<len(command):
                written=os.write(gate_w,command[offset:]); need(written>0,'birth_gate_write_incomplete'); offset+=written
            os.close(gate_w); gate_w=None; item['gate']=None
            end=min(self.active_end_ns,time.monotonic_ns()+5000_000_000)
            while True:
                self.check(); need(time.monotonic_ns()<end,'target_exec_timeout')
                if self._exited(popen.pid): raise GuardError('target_exited_before_bind')
                try: row=self._snapshot(popen.pid,handle)
                except GuardError as error:
                    if str(error)=='pid_exited':
                        need(self._exited(popen.pid),'target_exit_unverified'); raise GuardError('target_exited_before_bind')
                    need(str(error) in ('proc_executable_mismatch','process_identity_changed'),'target_identity_rejected')
                    current=self._minimal(popen.pid,handle); birth=item['birthRow']
                    need(all(current[k]==birth[k] for k in ('pid','parentPid','startTicks','pgid','sid','uid')),'birth_identity_changed')
                    time.sleep(.005); continue
                with open('/proc/%d/cmdline'%popen.pid,'rb') as f: argv=f.read(262145)
                need(len(argv)<=262144,'cmdline_too_large')
                if row['exe']['path']==expected['path'] and row['exe']['sha256']==expected['sha256'] and argv==b'\0'.join(x.encode() for x in [executable['path'],*args])+b'\0':
                    self._environment(popen.pid,env); need(os.readlink('/proc/%d/cwd'%popen.pid)==cwd,'inherited_cwd_mismatch')
                    if not check_target:
                        hold=min(self.active_end_ns,time.monotonic_ns()+200_000_000)
                        while time.monotonic_ns()<hold: self.check(); time.sleep(.005)
                        raise GuardError('target_proof_deliberately_rejected')
                    item.update(row=row,proof='registered',argvHash=sha(argv),cwd=cwd)
                    self._journal('launch_bound',role=role,pid=popen.pid,startTicks=row['startTicks'],parentPid=row['parentPid'],executableHash=row['exe']['sha256'])
                    self.entries[popen.pid]=item; self.held[popen.pid]=dict(handle=handle,row=row); self.roles[role]=popen.pid; del self.pending[popen.pid]
                    return self.record(popen.pid)
                time.sleep(.005)
        except BaseException as launch_error:
            exited_during_binding=item is not None and item.get('handle') is not None and self._exited(item['pid'])
            normalize_exit=exited_during_binding and (isinstance(launch_error,FileNotFoundError) or isinstance(launch_error,GuardError) and str(launch_error) in ('pid_exited','target_exit_unverified'))
            if gate_w is not None: os.close(gate_w); gate_w=None
            if item is not None: item['gate']=None
            # Exact birth capability, distinct from target execution authority.
            if item is not None:
                self._collect_cleanup_descendants(item)
                self._cleanup_item(item,'launch_rejected')
            if normalize_exit: raise GuardError('target_exited_before_bind') from None
            raise
        finally:
            for fd in (gate_r,gate_w,ready_r,ready_w):
                if fd is not None:
                    try: os.close(fd)
                    except OSError: pass
    def _minimal(self,pid,handle):
        self.check(); need(not select.select([handle],[],[],0)[0],'pid_exited')
        a=self._stat(pid); uid=base.parse_uid(self._read('/proc/%d/status'%pid,65536)); b=self._stat(pid)
        need(uid==self.uid and a==b and not select.select([handle],[],[],0)[0],'birth_identity_changed')
        return dict(**b,uid=uid)
    def _birth_verify(self,item):
        row=self._minimal(item['pid'],item['handle']); anchor=item['row']
        need(all(row[k]==anchor[k] for k in ('pid','parentPid','startTicks','pgid','sid','uid')),'birth_identity_changed'); return row
    def _collect_cleanup_descendants(self,parent_item,depth=0):
        need(depth<=16,'owned_depth_limit_exceeded')
        if parent_item.get('handle') is None or self._exited(parent_item['pid']): return
        self._birth_verify(parent_item)
        children=self._raw_children(parent_item['pid'])
        for pid in children:
            self.check()
            if pid in self.entries or pid in self.pending: continue
            need(len(self.entries)+len(self.pending)<64,'owned_process_limit_exceeded')
            handle=os.pidfd_open(pid,0)
            try:
                row=self._minimal(pid,handle)
                need(row['parentPid']==parent_item['pid'],'cleanup_birth_parent_mismatch'); self._birth_verify(parent_item)
                item=dict(pid=pid,handle=handle,row=row,birthRow=dict(row),birthParentStartTicks=parent_item['row']['startTicks'],proof='cleanup_only',environment=None,role='cleanup-'+str(pid),popen=None,reaped=False)
                self._journal('provisional_descendant_pinned',role=item['role'],pid=pid,startTicks=row['startTicks'],parentPid=row['parentPid'],parentStartTicks=item['birthParentStartTicks'],cleanupOnly=True)
                self.entries[pid]=item; self.roles[item['role']]=pid
                self._collect_cleanup_descendants(item,depth+1)
            except GuardError as error:
                if pid not in self.entries: os.close(handle)
                if str(error)!='pid_exited': raise
            except BaseException:
                if pid not in self.entries: os.close(handle)
                raise
        self._birth_verify(parent_item)
    def pin_specific(self,role,parent_role,pid,executable,proof):
        self.check(); need(len(self.entries)+len(self.pending)<64,'owned_process_limit_exceeded'); need(isinstance(role,str) and re.fullmatch('[a-z][a-z0-9_-]{0,63}',role) and role not in self.roles and pid not in self.entries and pid not in self.pending,'role_or_pid_already_registered')
        need(parent_role in self.roles,'role_unregistered'); parent=self.roles[parent_role]; before=self.verify(parent)
        need(pid in self._raw_children(parent),'not_a_current_controlled_child')
        handle=os.pidfd_open(pid,0); item=None
        try:
            minimal=self._minimal(pid,handle); need(minimal['parentPid']==parent,'owned_parent_mismatch'); self.verify(parent)
            # Cleanup-only capability survives any later executable/env rejection.
            item=dict(pid=pid,handle=handle,row=minimal,birthRow=dict(minimal),birthParentStartTicks=before['startTicks'],proof='cleanup_only',environment=None,role=role,popen=None,reaped=False)
            self._journal('provisional_descendant_pinned',role=role,pid=pid,startTicks=minimal['startTicks'],parentPid=parent,parentStartTicks=before['startTicks'],cleanupOnly=True)
            self.entries[pid]=item; self.roles[role]=pid
            row=self._snapshot(pid,handle)
            need(row['exe']['path']==executable['path'] and row['exe']['sha256']==executable['sha256'],'unexpected_executable')
            need(isinstance(proof,dict) and set(proof)<= {'args','cwd','environmentAdditions'} and isinstance(proof.get('args'),list),'descendant_proof_invalid')
            expected_args=proof['args']; need(len(expected_args)<=64 and all(isinstance(x,str) and '\0' not in x and len(x)<=4096 for x in expected_args),'argv_invalid')
            additions=proof.get('environmentAdditions',{}); need(isinstance(additions,dict) and set(additions)<={'TAURI_AUTOMATION','TAURI_WEBVIEW_AUTOMATION'} and all(value=='true' for value in additions.values()),'automation_environment_invalid')
            env=dict(self.environment,**additions); self._environment(pid,env)
            cwd=proof.get('cwd'); need(isinstance(cwd,str) and cwd.startswith(self.root+'/'),'cwd_outside_owned_root'); self._directory(cwd,owned=True)
            need(os.readlink('/proc/%d/cwd'%pid)==cwd,'inherited_cwd_mismatch')
            with open('/proc/%d/cmdline'%pid,'rb') as f: argv=f.read(262145)
            need(len(argv)<=262144 and argv==b'\0'.join(x.encode() for x in [executable['path'],*expected_args])+b'\0','inherited_argv_mismatch')
            self.verify(parent)
            item.update(row=row,birthRow=dict(row),proof='registered',environment=env,cwd=cwd,argvHash=sha(argv))
            self.held[pid]=dict(handle=handle,row=row)
            self._journal('descendant_pinned',role=role,pid=pid,startTicks=row['startTicks'],parentPid=parent,parentStartTicks=before['startTicks'],executableHash=row['exe']['sha256'])
            return self.record(pid)
        except BaseException:
            if item is None: os.close(handle)
            raise
    def pin_unique(self,role,parent_role,executable,proof):
        need(parent_role in self.roles,'role_unregistered'); parent=self.roles[parent_role]; self.verify(parent)
        children=self._raw_children(parent); matches=[]
        need(isinstance(proof,dict) and isinstance(proof.get('args'),list),'descendant_proof_invalid')
        args=proof['args']; additions=proof.get('environmentAdditions',{})
        need(isinstance(additions,dict) and set(additions)<={'TAURI_AUTOMATION','TAURI_WEBVIEW_AUTOMATION'} and all(x=='true' for x in additions.values()),'automation_environment_invalid')
        expected_env=dict(self.environment,**additions)
        for pid in children:
            handle=os.pidfd_open(pid,0)
            try:
                minimal=self._minimal(pid,handle); need(minimal['parentPid']==parent,'owned_parent_mismatch'); self.verify(parent)
                row=self._snapshot(pid,handle)
                need(row['parentPid']==parent,'owned_parent_mismatch')
                if row['exe']['path']!=executable['path'] or row['exe']['sha256']!=executable['sha256']: continue
                with open('/proc/%d/cmdline'%pid,'rb') as f: argv=f.read(262145)
                if len(argv)>262144 or argv!=b'\0'.join(x.encode() for x in [executable['path'],*args])+b'\0': continue
                if os.readlink('/proc/%d/cwd'%pid)!=proof.get('cwd'): continue
                self._environment(pid,expected_env); self.verify(parent); matches.append(pid)
            finally: os.close(handle)
        need(len(matches)==1,'ambiguous_descendants' if len(matches)>1 else 'owned_descendant_missing')
        self.verify(parent)
        return self.pin_specific(role,parent_role,matches[0],executable,proof)
    def children_roles(self,role):
        need(role in self.roles,'role_unregistered'); pid=self.roles[role]; self.verify(pid)
        result=self._raw_children(pid); self.verify(pid); return result
    def record(self,pid):
        item=self.entries.get(pid) or self.pending.get(pid); need(item is not None,'pid_unregistered')
        return dict(role=item['role'],pid=pid,startTicks=item.get('row',{}).get('startTicks'),parentPid=item.get('row',{}).get('parentPid'),birthParentPid=item.get('birthRow',{}).get('parentPid'),birthParentStartTicks=item.get('birthParentStartTicks'),proof=item.get('proof','pending'),reaped=item.get('reaped',False),adopted=item.get('adopted',False),exited=self._exited(pid) if item['handle'] is not None else False)
    def signal_owned(self,role,kind):
        need(role in self.roles,'role_unregistered'); pid=self.roles[role]
        need(self.entries[pid]['proof']=='registered','target_authority_missing')
        need(kind in ('TERM','KILL'),'signal_forbidden'); row=self.verify(pid)
        self._journal('signal_prepared',role=role,pid=pid,startTicks=row['startTicks'],signal=kind,cleanupOnly=False)
        try: signal.pidfd_send_signal(self.entries[pid]['handle'],getattr(signal,'SIG'+kind),None,0)
        except ProcessLookupError:
            need(self._exited(pid),'pidfd_signal_race_unverified'); self._journal('signal_not_dispatched',role=role,pid=pid,startTicks=row['startTicks'],signal=kind,reason='process_exited'); raise GuardError('owned_process_already_exited')
        self._journal('signal_dispatched',role=role,pid=pid,startTicks=row['startTicks'],signal=kind,dispatches=1)
        return dict(pid=pid,startTicks=row['startTicks'],dispatches=1)
    def adopt(self,role):
        need(role in self.roles,'role_unregistered'); pid=self.roles[role]; item=self.entries[pid]
        parent=item['birthRow']['parentPid']; need(parent in self.entries or parent in self.pending,'adoption_parent_not_controlled'); p=self.entries.get(parent) or self.pending[parent]
        need(p['row']['startTicks']==item['birthParentStartTicks'] and self._exited(parent),'adoption_parent_exit_unverified')
        row=self._snapshot(pid,item['handle']) if item['proof']=='registered' else self._minimal(pid,item['handle']); old=item['row']; expected=dict(old,parentPid=os.getpid())
        need(row==expected,'adoption_identity_mismatch')
        if item['environment'] is not None: self._environment(pid,item['environment'])
        need(pid in self._raw_children(os.getpid()),'adoption_not_direct_child')
        self._journal('adoption_bound',role=role,pid=pid,startTicks=row['startTicks'],birthParentPid=parent,birthParentStartTicks=item['birthParentStartTicks'],parentPid=os.getpid())
        item['row']=row; item['adopted']=True;
        if pid in self.held: self.held[pid]['row']=row
        return self.record(pid)
    def reap(self,role,max_ms=1000):
        need(role in self.roles,'role_unregistered'); need(isinstance(max_ms,int) and not isinstance(max_ms,bool) and 1<=max_ms<=5000,'reap_budget_invalid'); item=self.entries[self.roles[role]]
        return self._reap(item,max_ms)
    def _reap(self,item,max_ms):
        if item.get('reaped'): return self.record(item['pid'])
        end=min(self.hard_end_ns if self.cleaning else self.active_end_ns,time.monotonic_ns()+max_ms*1000000)
        while True:
            self.check(); need(time.monotonic_ns()<end,'reap_deadline_exceeded')
            if item['handle'] is not None and self._exited(item['pid']):
                try: pid,status=os.waitpid(item['pid'],os.WNOHANG)
                except ChildProcessError: raise GuardError('reap_not_helper_child')
                if pid==item['pid']:
                    if item['popen'] is not None: item['popen'].returncode=os.waitstatus_to_exitcode(status)
                    self._journal('process_reaped',role=item['role'],pid=pid,startTicks=item.get('row',{}).get('startTicks'),waitpidExact=True)
                    item['reaped']=True; item['exitCode']=os.waitstatus_to_exitcode(status)
                    return self.record(pid)
            time.sleep(.005)
    def _cleanup_item(self,item,reason):
        # Enter cleanup reserve but never reset absolute hard deadline.
        previous=self.cleaning; self.cleaning=True
        try:
            if item.get('reaped'): return
            if item.get('gate') is not None:
                os.close(item['gate']); item['gate']=None
            if item['handle'] is None:
                # Gate EOF guarantees bootstrap abort; exact Popen wait only.
                item['popen'].wait(timeout=max(.001,min(1,(self.hard_end_ns-time.monotonic_ns())/1e9)))
                item['reaped']=True; self._journal('process_reaped',role=item['role'],pid=item['pid'],startTicks=None,waitpidExact=True,birthGateAborted=True); return
            if not self._exited(item['pid']):
                # pidfd retained from Popen birth is cleanup-only authority even
                # when target exec/argv/env validation failed afterwards.
                for kind,wait_ms in (('TERM',250),('KILL',750)):
                    if self._exited(item['pid']): break
                    self._journal('signal_prepared',role=item['role'],pid=item['pid'],startTicks=item.get('birthRow',{}).get('startTicks'),signal=kind,cleanupOnly=True,reason=reason)
                    dispatched=True
                    try: signal.pidfd_send_signal(item['handle'],getattr(signal,'SIG'+kind),None,0)
                    except ProcessLookupError: need(self._exited(item['pid']),'pidfd_signal_race_unverified'); dispatched=False
                    self._journal('signal_dispatched' if dispatched else 'signal_not_dispatched',role=item['role'],pid=item['pid'],signal=kind,dispatches=1 if dispatched else 0,cleanupOnly=True)
                    until=min(self.hard_end_ns,time.monotonic_ns()+wait_ms*1000000)
                    while not self._exited(item['pid']) and time.monotonic_ns()<until: time.sleep(.005)
            self._reap(item,1000)
        finally: self.cleaning=previous
    def _adopt_cleanup(self,item):
        parent=item['birthRow']['parentPid']; p=self.entries.get(parent) or self.pending.get(parent)
        need(p is not None and p['row']['startTicks']==item['birthParentStartTicks'] and self._exited(parent),'adoption_parent_exit_unverified')
        row=self._minimal(item['pid'],item['handle']); anchor=item['row']
        need(row['parentPid']==os.getpid() and all(row[k]==anchor[k] for k in ('pid','startTicks','pgid','sid','uid')),'adoption_identity_mismatch')
        need(item['pid'] in self._raw_children(os.getpid()),'adoption_not_direct_child')
        self._journal('adoption_bound',role=item['role'],pid=item['pid'],startTicks=row['startTicks'],birthParentPid=parent,birthParentStartTicks=item['birthParentStartTicks'],parentPid=os.getpid(),cleanupOnly=True)
        item['row']=dict(item['row'],parentPid=os.getpid()); item['adopted']=True
        if item['pid'] in self.held: self.held[item['pid']]['row']=item['row']
    def cleanup(self,reason='close'):
        self.cleaning=True; failures=[]
        # Before stopping roots, retain all currently observable controlled
        # descendants as cleanup-only birth capabilities. Unknown or raced-away
        # ancestry remains a failure, never automatic signal authority.
        for item in [*list(self.pending.values()),*list(self.entries.values())]:
            if item.get('handle') is not None and item.get('row') is not None and not item.get('reaped'):
                try:
                    parent=item.get('birthRow',{}).get('parentPid'); p=self.entries.get(parent) or self.pending.get(parent)
                    if not self._exited(item['pid']) and parent!=os.getpid() and p is not None and self._exited(parent): self._adopt_cleanup(item)
                    self._collect_cleanup_descendants(item)
                except Exception: failures.append('descendant_collection_unverified')
        items=[*self.entries.values(),*self.pending.values()]
        need(len(items)<=64,'owned_process_limit_exceeded')
        # Parallel TERM/KILL barriers consume one bounded wait each, regardless
        # of the number of children. Reserve is never multiplied per process.
        for kind,wait_ms in (('TERM',250),('KILL',750)):
            for item in items:
                if item.get('reaped'): continue
                try:
                    if item.get('gate') is not None: os.close(item['gate']); item['gate']=None
                    if item['handle'] is None: continue
                    if self._exited(item['pid']): continue
                    self._journal('signal_prepared',role=item['role'],pid=item['pid'],startTicks=item.get('birthRow',{}).get('startTicks'),signal=kind,cleanupOnly=True,reason=reason)
                    dispatched=True
                    try: signal.pidfd_send_signal(item['handle'],getattr(signal,'SIG'+kind),None,0)
                    except ProcessLookupError: need(self._exited(item['pid']),'pidfd_signal_race_unverified'); dispatched=False
                    self._journal('signal_dispatched' if dispatched else 'signal_not_dispatched',role=item['role'],pid=item['pid'],signal=kind,dispatches=1 if dispatched else 0,cleanupOnly=True)
                except Exception: failures.append('owned_signal_unverified')
            until=min(self.hard_end_ns,time.monotonic_ns()+wait_ms*1000000)
            while time.monotonic_ns()<until:
                self.check()
                if all(item.get('reaped') or item.get('handle') is not None and self._exited(item['pid']) for item in items): break
                time.sleep(.005)
        # waitpid itself proves adopted zombie parentage even when a process
        # exited before a live /proc adoption snapshot could be captured.
        left=[item for item in items if not item.get('reaped')]
        end=min(self.hard_end_ns,time.monotonic_ns()+1500_000_000)
        while left and time.monotonic_ns()<end:
            self.check(); progress=False
            for item in list(left):
                try:
                    parent=item.get('birthRow',{}).get('parentPid')
                    p=self.entries.get(parent) or self.pending.get(parent)
                    if parent!=os.getpid() and not (p and p.get('reaped')): continue
                    if item['handle'] is not None and not self._exited(item['pid']):
                        if parent!=os.getpid(): self._adopt_cleanup(item)
                        continue
                    pid,status=os.waitpid(item['pid'],os.WNOHANG)
                    if pid!=item['pid']: continue
                    if item.get('popen') is not None: item['popen'].returncode=os.waitstatus_to_exitcode(status)
                    if parent is not None and parent!=os.getpid():
                        need(p is not None and self._exited(parent),'adoption_parent_exit_unverified')
                        self._journal('adopted_exit_reaped',role=item['role'],pid=pid,startTicks=item.get('row',{}).get('startTicks'),birthParentPid=parent,birthParentStartTicks=item['birthParentStartTicks'],waitpidExact=True)
                        item['adopted']=True
                    self._journal('process_reaped',role=item['role'],pid=pid,startTicks=item.get('row',{}).get('startTicks'),waitpidExact=True)
                    item['reaped']=True; left.remove(item); progress=True
                except ChildProcessError: failures.append('reap_not_helper_child'); left.remove(item)
                except Exception: failures.append('owned_reap_unverified'); left.remove(item)
            if not progress: time.sleep(.005)
        if left: failures.append('reap_deadline_exceeded')
        unknown=[pid for pid in self._raw_children(os.getpid()) if pid not in self.entries and pid not in self.pending]
        if unknown: failures.append('unowned_direct_children')
        complete=not failures and all(i.get('reaped') for i in items) and not self._raw_children(os.getpid())
        self._journal('cleanup_complete' if complete else 'cleanup_incomplete',ownedCount=len(items),allReaped=complete,unknownCount=len(unknown),reason=reason,failureCodes=sorted(set(failures)))
        self.cleanup_done=complete; need(complete,'owned_cleanup_unverified')
        return dict(allReaped=True,noDirectChildren=True,ownedCount=len(items),journalIdentity=dict(dev=str(self.journal_anchor.st_dev),ino=str(self.journal_anchor.st_ino),uid=self.journal_anchor.st_uid,mode=self.journal_anchor.st_mode,nlink=self.journal_anchor.st_nlink),records=[self.record(i['pid']) for i in items])
    def release(self):
        handles={i['handle'] for i in [*self.entries.values(),*self.pending.values()] if i.get('handle') is not None}
        for item in self.held.values(): handles.add(item['handle'])
        for handle in handles:
            try: os.close(handle)
            except OSError: pass
        self.held.clear()
        if self.journal_fd is not None: os.close(self.journal_fd); self.journal_fd=None

def birth_child():
    need(sys.platform.startswith('linux'),'platform_unsupported')
    need(len(sys.argv)==5,'birth_arguments_invalid'); gate,ready,parent=map(int,sys.argv[2:5])
    prctl(38,1); prctl(1,signal.SIGKILL); need(os.getppid()==parent,'birth_parent_gone')
    os.write(ready,('%d\n'%os.getpid()).encode()); os.close(ready)
    data=b''
    while not data.endswith(b'\n'):
        chunk=os.read(gate,4096)
        if not chunk: return 3
        data+=chunk; need(len(data)<=65536,'birth_command_too_large')
    os.close(gate); req=json.loads(data); need(isinstance(req,dict) and set(req)=={'executable','args','env','cwd'} and isinstance(req['executable'],str) and isinstance(req['args'],list) and isinstance(req['env'],dict),'birth_command_invalid'); need(os.getppid()==parent,'birth_parent_gone')
    os.execve(req['executable'],[req['executable'],*req['args']],req['env'])

def main():
    if not sys.platform.startswith('linux'):
        print(json.dumps(dict(status='rejected',code='platform_unsupported',nativeAttempted=False)),flush=True); return 2
    if len(sys.argv)>2 and sys.argv[1]=='--birth': return birth_child()
    authority=None; channel=None; close_ok=False
    try:
        need(len(sys.argv)==2,'arguments_invalid'); config=json.loads(sys.argv[1]); channel=config['channel']
        need(len(channel)==64 and all(x in '0123456789abcdef' for x in channel),'channel_invalid')
        authority=Supervisor(config['ownerPid'],int(config['originNs']),int(config['hardEndNs']),config['cleanupMs'],config['ownedRoot'],config['journalPath'],config['python'])
        source=authority._exe_file(os.path.abspath(__file__),False)['sha256']
        print(json.dumps(dict(status='ready',helper=authority.self_row,owner=authority.owner,channel=channel,sourceSha256=source,subreaper=True,originNs=str(authority.origin_ns),hardEndNs=str(authority.hard_end_ns),journalIdentity=dict(dev=str(authority.journal_anchor.st_dev),ino=str(authority.journal_anchor.st_ino),uid=authority.journal_anchor.st_uid,mode=authority.journal_anchor.st_mode,nlink=authority.journal_anchor.st_nlink))),flush=True)
        seq=0
        while True:
            authority.check(); end=authority.active_end_ns; readable=select.select([sys.stdin],[],[],max(0,(end-time.monotonic_ns())/1e9))[0]
            need(readable,'global_deadline_exceeded'); line=sys.stdin.readline(65537)
            if not line: break
            need(len(line)<=65536 and line.endswith('\n'),'request_too_large'); req=json.loads(line)
            need(req.get('channel')==channel and isinstance(req.get('seq'),int) and not isinstance(req.get('seq'),bool) and req.get('seq')==seq+1,'request_binding_invalid'); seq=req['seq']; op=req['operation']
            try:
                if op=='launch': value=authority.spawn_owned(req['role'],req['executable'],req['args'],req['env'],req['cwd'])
                elif op=='launch_reject_proof': value=authority.spawn_owned(req['role'],req['executable'],req['args'],req['env'],req['cwd'],False)
                elif op=='pin': value=authority.pin_specific(req['role'],req['parentRole'],req['pid'],req['executable'],req['proof'])
                elif op=='pin_unique': value=authority.pin_unique(req['role'],req['parentRole'],req['executable'],req['proof'])
                elif op=='children': value=authority.children_roles(req['role'])
                elif op=='verify': value=authority.verify(authority.roles[req['role']]) if req['role'] in authority.roles else (_ for _ in ()).throw(GuardError('role_unregistered'))
                elif op=='port': need(req['role'] in authority.roles,'role_unregistered'); value=authority.port(authority.roles[req['role']],req['port'])
                elif op=='signal': value=authority.signal_owned(req['role'],req['signal'])
                elif op=='adopt': value=authority.adopt(req['role'])
                elif op=='reap': value=authority.reap(req['role'],req.get('maxMs',1000))
                elif op=='snapshot': value=[authority.record(i['pid']) for i in [*authority.entries.values(),*authority.pending.values()]]
                elif op=='close':
                    value=authority.cleanup('close'); close_ok=True
                    print(json.dumps(dict(status='ok',seq=seq,value=value,channel=channel)),flush=True); break
                else: raise GuardError('operation_forbidden')
                print(json.dumps(dict(status='ok',seq=seq,value=value,channel=channel)),flush=True)
            except Exception as error:
                code=str(error) if isinstance(error,GuardError) else 'native_operation_failed'
                print(json.dumps(dict(status='rejected',seq=seq,code=code,channel=channel)),flush=True)
    except Exception as error:
        code=str(error) if isinstance(error,GuardError) else 'native_helper_failed'
        print(json.dumps(dict(status='rejected',code=code,channel=channel)),flush=True)
    finally:
        if authority:
            try:
                if not close_ok: authority.cleanup('eof_or_failure')
                close_ok=authority.cleanup_done
            except Exception: close_ok=False
            authority.release()
    return 0 if close_ok else 2

if __name__=='__main__': sys.exit(main())
