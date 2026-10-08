"""Fresh-profile evidence/cleanup only, never a user directory walker."""
import hashlib,json,os,stat,sys,time
from pathlib import PurePosixPath

def need(ok,code):
    if not ok: raise ValueError(code)

def host(): need(os.name=='posix' and sys.platform in ('linux','darwin'),'platform_unsupported')

def identity(s): return [s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns]

def directory(s): return [s.st_dev,s.st_ino,s.st_uid,s.st_mode]

def path_parts(path):
    need(isinstance(path,str) and path.startswith('/') and '\0' not in path,'owned_path_invalid')
    parts=path.split('/')[1:]
    need(parts and all(p not in ('','.','..') and p.lower()!='memory.md' for p in parts),'owned_path_invalid')
    return parts

def dirfd(path,owned_root):
    parts=path_parts(path);roots=path_parts(owned_root)
    need(parts[:len(roots)]==roots,'owned_path_outside')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for i,p in enumerate(parts):
            nxt=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
            s=os.fstat(fd)
            if i>=len(roots)-1: need(s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700,'owned_directory_invalid')
        return fd
    except BaseException: os.close(fd);raise

def fingerprint(path,root,end):
    host();need(time.monotonic_ns()<end,'owned_deadline')
    parts=path_parts(path);fd=dirfd('/'+'/'.join(parts[:-1]),root);leaf=None
    try:
        leaf=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd);a=os.fstat(leaf)
        need(stat.S_ISREG(a.st_mode) and a.st_uid==os.getuid() and a.st_nlink==1 and a.st_size<=131072,'owned_file_invalid')
        chunks=[];size=0
        while True:
            need(time.monotonic_ns()<end,'owned_deadline');b=os.read(leaf,65536)
            if not b: break
            chunks.append(b);size+=len(b);need(size<=131072,'owned_file_limit')
        need(identity(a)==identity(os.fstat(leaf))==identity(os.stat(parts[-1],dir_fd=fd,follow_symlinks=False)),'owned_file_changed')
        return {'dev':str(a.st_dev),'ino':str(a.st_ino),'uid':a.st_uid,'mode':stat.S_IMODE(a.st_mode),'nlink':a.st_nlink,'bytes':size,'mtimeNs':str(a.st_mtime_ns),'ctimeNs':str(a.st_ctime_ns),'sha256':hashlib.sha256(b''.join(chunks)).hexdigest()}
    finally:
        if leaf is not None: os.close(leaf)
        os.close(fd)

def cleanup(path,root,anchor,end):
    host();parts=path_parts(path);need(path!=root,'cannot_remove_runtime_root');parent=dirfd('/'+'/'.join(parts[:-1]),root);held=None;counts={'files':0,'directories':0};seen=set()
    def visit(fd):
        need(time.monotonic_ns()<end,'cleanup_deadline');s=os.fstat(fd);key=(s.st_dev,s.st_ino);need(key not in seen,'cleanup_directory_cycle');seen.add(key)
        names=os.listdir(fd);need(len(names)<=2048,'cleanup_entry_limit')
        for name in names:
            need(name not in ('.','..') and name.lower()!='memory.md' and '/' not in name,'cleanup_name_forbidden');need(time.monotonic_ns()<end,'cleanup_deadline');a=os.stat(name,dir_fd=fd,follow_symlinks=False)
            need(a.st_uid==os.getuid(),'cleanup_owner_changed')
            if stat.S_ISDIR(a.st_mode):
                child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                try:
                    need(directory(os.fstat(child))==directory(a) and stat.S_IMODE(a.st_mode)==0o700,'cleanup_directory_changed');visit(child);need(directory(os.stat(name,dir_fd=fd,follow_symlinks=False))==directory(a),'cleanup_directory_changed');os.rmdir(name,dir_fd=fd);counts['directories']+=1
                finally: os.close(child)
            else:
                need(stat.S_ISREG(a.st_mode) and a.st_nlink==1,'cleanup_nonregular_or_hardlink');leaf=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
                try: need(identity(os.fstat(leaf))==identity(a)==identity(os.stat(name,dir_fd=fd,follow_symlinks=False)),'cleanup_file_changed');os.unlink(name,dir_fd=fd);counts['files']+=1
                finally: os.close(leaf)
            need(counts['files']+counts['directories']<=8192,'cleanup_total_limit')
    try:
        held=os.open(parts[-1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent);a=os.fstat(held)
        need(directory(a)==anchor and a.st_uid==os.getuid() and stat.S_IMODE(a.st_mode)==0o700,'cleanup_root_changed');visit(held);need(directory(os.stat(parts[-1],dir_fd=parent,follow_symlinks=False))==anchor,'cleanup_root_changed');os.rmdir(parts[-1],dir_fd=parent)
        try: os.stat(parts[-1],dir_fd=parent,follow_symlinks=False)
        except FileNotFoundError: return dict(counts,removed=True)
        raise ValueError('cleanup_still_exists')
    finally:
        if held is not None: os.close(held)
        os.close(parent)

def main():
    host();need(len(sys.argv) in (5,6),'owned_args');mode,path,root,end=sys.argv[1:5];end=int(end)
    need(time.monotonic_ns()<end<=time.monotonic_ns()+10_000_000_000,'owned_budget')
    if mode=='fingerprint': result=fingerprint(path,root,end)
    elif mode=='cleanup' and len(sys.argv)==6: result=cleanup(path,root,json.loads(sys.argv[5]),end)
    else: raise ValueError('owned_mode')
    print(json.dumps(result,separators=(',',':')))

if __name__=='__main__':
    try: main()
    except BaseException:
        print('{"passed":false,"code":"owned_file_operation_rejected"}');sys.exit(1)
