#!/usr/bin/env python3
"""Synthetic owned processes only. No sockets, DB, credentials, provider I/O."""
import os, subprocess, sys, time
if not sys.platform.startswith('linux'): sys.exit(2)
mode=sys.argv[1]
if mode=='exit': sys.exit(0)
if mode=='parent-two':
    children=[subprocess.Popen([sys.executable,'-I','-B',os.path.abspath(__file__),'leaf'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=dict(os.environ),cwd=os.getcwd(),close_fds=True) for _ in range(2)]
if mode=='drift-cwd':
    time.sleep(.3); os.chdir(sys.argv[2])
while True: time.sleep(.05)
