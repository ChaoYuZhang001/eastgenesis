#!/usr/bin/env python3
"""Linux-only exact-PID authority. Importing exposes pure parsers only.

The /proc/<pid>/exe and fd links are kernel identity interfaces, not accepted
filesystem symlinks. Executable paths themselves must have no symlink component.
No process-name scan, /proc glob, user config, database, or environment dump.
"""
import hashlib, json, os, re, select, signal, stat, subprocess, sys, time

class GuardError(Exception): pass
def need(ok, code):
    if not ok: raise GuardError(code)
def positive(v): return isinstance(v, int) and not isinstance(v, bool) and 0 < v <= 2147483647

def parse_proc_stat(text, expected_pid):
    need(len(text) <= 8192, 'proc_stat_too_large')
    end = text.rfind(') '); first = text.find(' ')
    need(end > first and first > 0 and int(text[:first]) == expected_pid, 'proc_stat_invalid')
    fields = text[end+2:].split()
    need(len(fields) >= 22 and fields[0] not in ('Z','X','x'), 'pid_exited')
    row = dict(pid=expected_pid, parentPid=int(fields[1]), pgid=int(fields[2]), sid=int(fields[3]), startTicks=fields[19])
    need(all(positive(row[k]) for k in ('pid','parentPid','pgid','sid')) and row['startTicks'].isdigit() and int(row['startTicks']) > 0, 'proc_stat_invalid')
    return row

def parse_uid(text):
    rows = [line.split()[1:] for line in text.splitlines() if line.startswith('Uid:')]
    need(len(rows) == 1 and len(rows[0]) == 4 and all(x.isdigit() for x in rows[0]), 'uid_invalid')
    values = list(map(int, rows[0])); need(len(set(values)) == 1, 'uid_changed'); return values[0]

def parse_task_status(text,tid,tgid,uid):
    fields={}
    for name in ('Pid','Tgid'):
        rows=[line.split()[1:] for line in text.splitlines() if line.startswith(name+':')]
        need(len(rows)==1 and len(rows[0])==1 and rows[0][0].isdigit(),'task_status_invalid')
        fields[name]=int(rows[0][0])
    need(fields['Pid']==tid and fields['Tgid']==tgid and parse_uid(text)==uid,'task_identity_mismatch')

def collect_thread_children(read,list_directory,verify_parent,pid,uid,check):
    # Only this already birth-bound PID's task directory is listed. No global
    # /proc scan, signal capability or child registration is created here.
    check(); before=verify_parent();need(before['pid']==pid and before['uid']==uid,'parent_birth_invalid')
    directory='/proc/%d/task'%pid
    def tids():
        check(); values=list_directory(directory)
        need(len(values)<=256 and len(values)==len(set(values)) and all(x.isdigit() and positive(int(x)) for x in values) and str(pid) in values,'task_list_invalid')
        return sorted(map(int,values))
    first=tids();result=set()
    for tid in first:
        check();path=directory+'/%d'%tid
        a=parse_proc_stat(read(path+'/stat',8192),tid);parse_task_status(read(path+'/status',65536),tid,pid,uid)
        values=read(path+'/children',8192).split()
        need(len(values)<=64 and len(values)==len(set(values)) and all(x.isdigit() and positive(int(x)) for x in values),'children_invalid')
        for value in values:
            child=int(value);check();c=parse_proc_stat(read('/proc/%d/stat'%child,8192),child)
            parse_task_status(read('/proc/%d/status'%child,65536),child,child,uid)
            need(c['parentPid']==pid and c==parse_proc_stat(read('/proc/%d/stat'%child,8192),child),'child_ancestry_raced')
            result.add(child);need(len(result)<=64,'children_limit_exceeded')
        b=parse_proc_stat(read(path+'/stat',8192),tid);parse_task_status(read(path+'/status',65536),tid,pid,uid)
        need(a==b and values==read(path+'/children',8192).split(),'thread_children_raced')
    need(tids()==first and verify_parent()==before,'parent_threads_raced')
    check();return sorted(result)

def validate_descendant_environment(actual,inherited,additions,kind):
    need(isinstance(actual,dict) and isinstance(inherited,dict) and isinstance(additions,dict),'environment_invalid')
    need(set(additions)<={'TAURI_AUTOMATION','TAURI_WEBVIEW_AUTOMATION'} and all(v=='true' for v in additions.values()),'automation_environment_invalid')
    need(kind in ('inherited','mcp_builtin','native_spawned_app'),'descendant_environment_kind_invalid')
    need(set(inherited)<=ENV_KEYS,'inherited_environment_not_fresh')
    if kind=='mcp_builtin':
        need(not additions,'mcp_environment_additions_forbidden')
        expected={k:v for k,v in inherited.items() if k in ('PATH','HOME','LANG','LC_ALL','TMPDIR')}
        need(set(expected)=={'PATH','HOME','LANG','LC_ALL','TMPDIR'} and actual==expected,'inherited_environment_mismatch')
        return {'environmentKind':kind}
    expected=dict(inherited,**additions)
    if kind=='native_spawned_app':
        need(additions=={'TAURI_AUTOMATION':'true','TAURI_WEBVIEW_AUTOMATION':'true'},'native_app_automation_required')
        need(set(actual)==set(expected)|{'WEBKIT_INSPECTOR_SERVER','GTK_OVERLAY_SCROLLING'},'native_app_environment_keys')
        server=actual.get('WEBKIT_INSPECTOR_SERVER');match=re.fullmatch(r'127\.0\.0\.1:([1-9][0-9]{0,4})',server or '')
        need(match is not None and 1024<=int(match.group(1))<=65535,'native_app_inspector_invalid')
        need(actual.get('GTK_OVERLAY_SCROLLING') in ('0','1'),'native_app_gtk_overlay_invalid')
        need(all(actual.get(k)==v for k,v in expected.items()),'inherited_environment_mismatch')
        return {'environmentKind':kind,'inspectorServer':server,'inspectorPort':int(match.group(1)),'gtkOverlayScrolling':actual['GTK_OVERLAY_SCROLLING']}
    need(actual==expected,'inherited_environment_mismatch');return {'environmentKind':kind}

def parse_listening_inodes(text, port):
    need(positive(port) and port <= 65535 and len(text) <= 1048576, 'port_invalid')
    result = []
    for line in text.splitlines()[1:]:
        parts = line.split(); need(len(parts) >= 10, 'proc_net_invalid')
        address, p = parts[1].split(':'); need(len(address) == 8 and len(p) == 4, 'proc_net_invalid')
        if int(p,16) == port and parts[3] == '0A':
            need(address == '0100007F', 'control_port_not_loopback')
            need(parts[9].isdigit(), 'socket_inode_invalid'); result.append(parts[9])
    need(len(result) <= 1, 'ambiguous_port_listener'); return result

ENV_KEYS = frozenset(['PATH','HOME','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','LANG','LC_ALL','DISPLAY','XAUTHORITY','WEBKIT_DISABLE_COMPOSITING_MODE','EASTGENESIS_QA_ISOLATED_PROFILE','EASTGENESIS_QA_STARTUP_DIAGNOSTICS','EASTGENESIS_QA_INSTALL_ISOLATION_REQUIRED','EASTGENESIS_QA_STARTUP_RUN_ID','EASTGENESIS_QA_GOAL_OBSERVER'])

class LinuxAuthority:
    def __init__(self, owner_pid, deadline_ms):
        # Guard precedes /proc reads, spawn, network, stdin commands, and links.
        need(sys.platform.startswith('linux'), 'platform_unsupported')
        need(hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'), 'pidfd_unavailable')
        need(positive(owner_pid) and os.getppid() == owner_pid and 1 <= deadline_ms <= 300000, 'owner_invalid')
        self.hard_end = time.monotonic() + deadline_ms/1000; self.end = self.hard_end - 5; self.uid = os.getuid(); self.held = {}; self.spawned = {}
        self.owner = self._pin(owner_pid)
        self.self_row = self._pin(os.getpid(), owner_pid)
    def check(self): need(time.monotonic() < self.end, 'global_deadline_exceeded')
    def _read(self,path,limit):
        self.check()
        with open(path,'r',encoding='utf-8') as f: value=f.read(limit+1)
        need(len(value) <= limit, 'native_read_too_large'); return value
    def _stat(self,pid): return parse_proc_stat(self._read('/proc/%d/stat'%pid,8192),pid)
    def _exe_file(self,path,executable=True):
        need(isinstance(path,str) and path.startswith('/') and len(path)<=4096 and all(p not in ('.','..','') for p in path.split('/')[1:]), 'executable_path_invalid')
        # openat walk rejects links on every filesystem component, including
        # the final regular executable; compare metadata before/after hashing.
        fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
        try:
            parts=path.split('/')[1:]
            for part in parts[:-1]:
                nextfd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=nextfd
            exe=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
            try:
                a=os.fstat(exe); need(stat.S_ISREG(a.st_mode) and a.st_nlink == 1 and (not executable or a.st_mode & 0o111) and a.st_size <= 268435456, 'executable_not_regular_single_link')
                h=hashlib.sha256()
                while True:
                    self.check(); chunk=os.read(exe,1048576)
                    if not chunk: break
                    h.update(chunk)
                b=os.fstat(exe)
                need((a.st_dev,a.st_ino,a.st_size,a.st_mode,a.st_mtime_ns,a.st_ctime_ns)==(b.st_dev,b.st_ino,b.st_size,b.st_mode,b.st_mtime_ns,b.st_ctime_ns), 'executable_changed')
                return dict(path=path,sha256=h.hexdigest(),dev=str(b.st_dev),ino=str(b.st_ino),mode=b.st_mode,size=str(b.st_size),mtimeNs=str(b.st_mtime_ns),ctimeNs=str(b.st_ctime_ns))
            finally: os.close(exe)
        finally: os.close(fd)
    def _snapshot(self,pid,handle):
        self.check(); need(not select.select([handle],[],[],0)[0], 'pid_exited')
        a=self._stat(pid); uid=parse_uid(self._read('/proc/%d/status'%pid,65536)); need(uid==self.uid,'uid_changed')
        path=os.readlink('/proc/%d/exe'%pid); need(not path.endswith(' (deleted)'), 'executable_deleted')
        exe=self._exe_file(path)
        proc_exe=os.stat('/proc/%d/exe'%pid)
        need(str(proc_exe.st_dev)==exe['dev'] and str(proc_exe.st_ino)==exe['ino'], 'proc_executable_mismatch')
        b=self._stat(pid); need(a==b and not select.select([handle],[],[],0)[0], 'process_identity_changed')
        need(os.readlink('/proc/%d/exe'%pid)==path and parse_uid(self._read('/proc/%d/status'%pid,65536))==uid, 'process_identity_changed')
        return dict(**b,uid=uid,exe=exe)
    def _pin(self,pid,parent=None,expected=None):
        need(positive(pid) and pid not in self.held, 'pid_already_registered')
        if parent is not None:
            self.verify(parent)
            need(pid in self.children(parent),'not_a_current_controlled_child')
        handle=os.pidfd_open(pid,0)
        try:
            row=self._snapshot(pid,handle)
            if parent is not None:
                self.verify(parent); need(row['parentPid']==parent,'owned_parent_mismatch')
            if expected is not None: need(row['exe']['path']==expected['path'] and row['exe']['sha256']==expected['sha256'],'unexpected_executable')
            self.held[pid]=dict(handle=handle,row=row); return row
        except BaseException: os.close(handle); raise
    def verify(self,pid):
        self.check(); need(pid in self.held,'pid_unregistered'); anchor=self.held[pid]
        row=self._snapshot(pid,anchor['handle']); need(row==anchor['row'],'process_identity_changed'); return row
    def spawn_driver(self,executable,args,env,cwd):
        raise GuardError('owned_launcher_not_implemented')
    def children(self,pid):
        need(pid in self.held,'pid_unregistered');anchor=self.held[pid]
        return self._children_at_bound(pid,anchor['row'],anchor['handle'])
    def _children_at_bound(self,pid,anchor,handle):
        need(positive(pid) and isinstance(anchor,dict) and anchor.get('pid')==pid and handle is not None,'parent_birth_invalid')
        def verify_parent():
            self.check();need(not select.select([handle],[],[],0)[0],'pid_exited')
            a=self._stat(pid);status=self._read('/proc/%d/status'%pid,65536)
            parse_task_status(status,pid,pid,self.uid);b=self._stat(pid)
            row=dict(**b,uid=self.uid)
            need(a==b and all(row[k]==anchor[k] for k in ('pid','parentPid','pgid','sid','startTicks','uid')) and not select.select([handle],[],[],0)[0],'parent_birth_changed')
            return row
        return collect_thread_children(self._read,os.listdir,verify_parent,pid,self.uid,self.check)
    def pin_child(self,pid,parent,expected): return self._pin(pid,parent,expected)
    def port(self,pid,port):
        before=self.verify(pid); owned=set()
        directory='/proc/%d/fd'%pid
        names=os.listdir(directory); need(len(names)<=4096,'fd_count_exceeded')
        for name in names:
            self.check(); need(name.isdigit(),'fd_invalid')
            try: value=os.readlink(directory+'/'+name)
            except FileNotFoundError: continue
            if value.startswith('socket:[') and value.endswith(']'): owned.add(value[8:-1])
        listeners=parse_listening_inodes(self._read('/proc/%d/net/tcp'%pid,1048576),port)
        need(len(listeners)==1 and listeners[0] in owned,'control_port_not_owned')
        # IPv6 dual-stack/all-address listeners on the same port are forbidden.
        tcp6=self._read('/proc/%d/net/tcp6'%pid,1048576)
        for line in tcp6.splitlines()[1:]:
            parts=line.split(); need(len(parts)>=10,'proc_net_invalid')
            if int(parts[1].split(':')[1],16)==port and parts[3]=='0A': raise GuardError('control_port_ipv6_forbidden')
        self.verify(pid); return dict(pid=pid,startTicks=before['startTicks'],port=port,address='127.0.0.1',inode=listeners[0])
    def signal_exact(self,pid,kind):
        need(kind in ('TERM','KILL') and pid not in (self.owner['pid'],os.getpid()),'signal_forbidden')
        row=self.verify(pid); signal.pidfd_send_signal(self.held[pid]['handle'],getattr(signal,'SIG'+kind),None,0)
        return dict(pid=pid,startTicks=row['startTicks'],signal=kind,dispatches=1)
    def exited(self,pid):
        need(pid in self.held,'pid_unregistered'); self.check()
        ended=bool(select.select([self.held[pid]['handle']],[],[],0)[0])
        if ended and pid in self.spawned: self.spawned[pid].wait(timeout=0.1)
        return ended
    def release(self):
        for item in self.held.values(): os.close(item['handle'])
        self.held.clear()

def main():
    # No stdin command, process spawn, or /proc access on unsupported hosts.
    if not sys.platform.startswith('linux'):
        print(json.dumps(dict(status='rejected',code='platform_unsupported',nativeAttempted=False)),flush=True); return 2
    authority=None
    try:
        need(len(sys.argv)==4 and len(sys.argv[3])==64 and all(c in '0123456789abcdef' for c in sys.argv[3]),'arguments_invalid'); channel=sys.argv[3]; authority=LinuxAuthority(int(sys.argv[1]),int(sys.argv[2]))
        script_hash=authority._exe_file(os.path.abspath(__file__),False)['sha256']
        print(json.dumps(dict(status='ready',owner=authority.owner,helper=authority.self_row,channel=channel,scriptSha256=script_hash)),flush=True)
        while True:
            authority.check(); ready=select.select([sys.stdin],[],[],max(0,authority.end-time.monotonic()))[0]
            need(ready,'global_deadline_exceeded'); line=sys.stdin.readline(65537)
            if not line: break
            need(len(line)<=65536 and line.endswith('\n'),'request_too_large'); req=json.loads(line); need(req.get('channel')==channel,'channel_mismatch'); seq=req['seq']; op=req['operation']
            try:
                if op=='spawn': value=authority.spawn_driver(req['executable'],req['args'],req['env'],req['cwd'])
                elif op=='read': value=authority.verify(req['pid'])
                elif op=='children': value=authority.children(req['pid'])
                elif op=='pin_child': value=authority.pin_child(req['pid'],req['parentPid'],req['executable'])
                elif op=='port': value=authority.port(req['pid'],req['port'])
                elif op=='signal': value=authority.signal_exact(req['pid'],req['signal'])
                elif op=='exited': value=authority.exited(req['pid'])
                elif op=='close':
                    # close() never silently kills children or asserts cleanup.
                    active=[p for p in authority.held if p not in (authority.owner['pid'],os.getpid()) and not authority.exited(p)]
                    need(not active,'owned_processes_still_live'); print(json.dumps(dict(seq=seq,status='ok',value=None,channel=channel)),flush=True); break
                else: raise GuardError('operation_forbidden')
                print(json.dumps(dict(seq=seq,status='ok',value=value,channel=channel)),flush=True)
            except Exception as error:
                code=str(error) if isinstance(error,GuardError) else 'native_operation_failed'
                print(json.dumps(dict(seq=seq,status='rejected',code=code,channel=channel)),flush=True)
    except Exception as error:
        code=str(error) if isinstance(error,GuardError) else 'native_helper_failed'
        print(json.dumps(dict(status='rejected',code=code)),flush=True); return 2
    finally:
        # Identity-only slice cannot claim emergency descendant cleanup.
        # Do not silently signal on EOF; the next owned-launcher slice must add
        # pending birth handles, controlled adoption and exact reaping.
        if authority:
            authority.release()
    return 0

if __name__=='__main__': sys.exit(main())
