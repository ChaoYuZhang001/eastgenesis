#!/usr/bin/env python3
"""Synthetic owned processes only. No sockets, DB, credentials, provider I/O."""
import json,os, subprocess, sys,threading,time
if not sys.platform.startswith('linux'): sys.exit(2)
mode=sys.argv[1]
if mode=='exit': sys.exit(0)
if mode=='worker-thread-two':
    # The worker remains live so its kernel task/children file is observable.
    # These exact children are synthetic; no App, sockets or Provider exists.
    ready=sys.argv[2]
    def worker():
        children=[subprocess.Popen([sys.executable,'-I','-B',os.path.abspath(__file__),'leaf'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=dict(os.environ),cwd=os.getcwd(),close_fds=True) for _ in range(2)]
        with open('/proc/self/task/%d/children'%os.getpid(),'r') as f:main_children=f.read(8193)
        row={'parentPid':os.getpid(),'workerTid':threading.get_native_id(),'children':[p.pid for p in children],'mainThreadChildren':main_children.split()}
        fd=os.open(ready,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            raw=(json.dumps(row)+'\n').encode();off=0
            while off<len(raw):off+=os.write(fd,raw[off:])
            os.fsync(fd);os.fchmod(fd,0o400)
        finally:os.close(fd)
        while True:time.sleep(.05)
    threading.Thread(target=worker,daemon=True).start()
while True: time.sleep(.05)
