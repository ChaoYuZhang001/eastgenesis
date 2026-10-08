"""Owned, gated, bounded evidence helper. Born through retained pidfd launcher."""
import contextlib,hashlib,io,json,os,stat,sys,time

def need(ok,code):
    if not ok: raise ValueError(code)

def parts(path):
    need(isinstance(path,str) and path.startswith('/') and '\0' not in path,'operation_path')
    values=path.split('/')[1:];need(all(v not in ('','.','..') and v.lower()!='memory.md' for v in values),'operation_path');return values

def parent(path,root):
    p=parts(path);r=parts(root);need(p[:len(r)]==r and len(p)>len(r),'operation_outside_root');fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for i,name in enumerate(p[:-1]):
            nxt=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt;s=os.fstat(fd)
            if i>=len(r)-1: need(s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700,'operation_directory')
        return fd,p[-1]
    except BaseException: os.close(fd);raise

def main():
    need(sys.platform=='linux','platform_unsupported');need(len(sys.argv)==2,'operation_args');c=json.loads(sys.argv[1]);need(set(c)=={'root','source','sourceSha256','args','gate','output','endNs'},'operation_shape');end=int(c['endNs']);need(time.monotonic_ns()<end<=time.monotonic_ns()+10_000_000_000,'operation_budget');need(os.path.basename(c['source']) in ('physical-goal-snapshot.py','runtime-owned-files.py'),'operation_source');need(isinstance(c['args'],list) and all(isinstance(x,str) and len(x)<=4096 for x in c['args']),'operation_argv')
    p,name=parent(c['source'],c['root']);fd=None
    try:
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=p);a=os.fstat(fd);need(stat.S_ISREG(a.st_mode) and a.st_uid==os.getuid() and a.st_nlink==1 and a.st_size<=131072,'operation_source_file');raw=os.read(fd,131073);need(hashlib.sha256(raw).hexdigest()==c['sourceSha256'] and all(getattr(a,k)==getattr(os.fstat(fd),k) for k in ('st_dev','st_ino','st_uid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')),'operation_source_hash');compiled=compile(raw,c['source'],'exec')
    finally:
        if fd is not None: os.close(fd)
        os.close(p)
    p,name=parent(c['gate'],c['root'])
    try:
        while True:
            need(time.monotonic_ns()<end,'operation_gate_deadline')
            try:
                fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=p)
                try:
                    s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o400 and os.read(fd,2)==b'1','operation_gate_invalid')
                finally: os.close(fd)
                break
            except FileNotFoundError: time.sleep(.005)
    finally: os.close(p)
    stream=io.StringIO();sys.argv=[c['source'],*c['args']];exit_code=0
    with contextlib.redirect_stdout(stream),contextlib.redirect_stderr(io.StringIO()):
        try: exec(compiled,{'__name__':'__main__','__file__':c['source']})
        except SystemExit as e: exit_code=e.code if isinstance(e.code,int) else 1
    need(time.monotonic_ns()<end and exit_code==0,'operation_failed_or_late');raw=stream.getvalue();need(len(raw.encode())<=131072,'operation_output_limit');value=json.loads(raw);out=json.dumps({'passed':True,'exitCode':0,'result':value},ensure_ascii=False,separators=(',',':')).encode();need(len(out)<=196608,'operation_output_limit');p,name=parent(c['output'],c['root']);fd=None
    try:
        fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=p);offset=0
        while offset<len(out): need(time.monotonic_ns()<end,'operation_deadline');n=os.write(fd,out[offset:]);need(n>0,'operation_short_write');offset+=n
        os.fsync(fd);os.fchmod(fd,0o400)
    finally:
        if fd is not None: os.close(fd)
        os.close(p)

if __name__=='__main__':
    try: main()
    except BaseException: sys.exit(1)
