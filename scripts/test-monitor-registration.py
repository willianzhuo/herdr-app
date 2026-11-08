#!/usr/bin/env python3
"""Check detached registration, PID reuse and actual URL acknowledgements."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

sys.dont_write_bytecode=True
folder=Path(__file__).resolve().parents[1]/'defaults/mods/ports'
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,folder/file)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result)
    return result
ports=module('ports','forward.py');monitor=module('monitor','herdr-monitor.py')
with tempfile.TemporaryDirectory() as tmp:
    home=Path(tmp);proc=home/'proc';pid=proc/'42';(pid/'fd').mkdir(parents=True)
    fields=['S','1']+['0']*17+['12345']
    (pid/'stat').write_text('42 (detached tensorboard) '+' '.join(fields))
    (pid/'fd/3').symlink_to('socket:[777]')
    (proc/'net').mkdir();(proc/'net/tcp').write_text('header\n0: 0100007F:1776 00000000:0000 0A 0 0 0 0 0 777\n')
    real_path=Path
    def mapped(value):
        text=str(value)
        return proc/text[6:] if text.startswith('/proc/') else proc if text=='/proc' else real_path(value)
    with patch.object(monitor,'Path',side_effect=mapped),patch.object(monitor,'directory',return_value=home):
        result=monitor.request(6006,42,'Detached TensorBoard',path='/#scalars')
        assert result['request']['start']=='12345'
        try:monitor.request(6007,42,'Wrong port');raise AssertionError('accepted unrelated socket')
        except ValueError:pass
    registry=home/'.config/herdr-custom/port-forwarding';registry.mkdir(parents=True)
    request=result['request']
    # A stale record must not prevent a later valid registration being discovered.
    (registry/'requests.json').write_text(json.dumps({'requests':[dict(request,pid=999),request]}))
    probe=ports.PROBE.replace("Path('/proc')",'Path('+repr(str(proc))+')').replace("Path('/proc/net/'+table)",'(Path('+repr(str(proc/'net'))+')/table)').replace('Path.home()', 'Path('+repr(str(home))+')')
    def scan():
        output=io.StringIO()
        with patch.object(sys,'argv',['probe','[]']),contextlib.redirect_stdout(output):exec(probe,{})
        return json.loads(output.getvalue())
    rows=scan();assert len(rows)==1 and rows[0]['label']=='Detached TensorBoard' and rows[0]['path']=='/#scalars',rows
    (pid/'stat').write_text('42 (new process) '+' '.join(fields[:-1]+['99999']))
    assert scan()==[], 'recycled PID revived a stale registration'
    clients=home/'clients';clients.mkdir()
    response=clients/'mac.json'
    response.write_text(json.dumps({'client':{'id':'mac','name':'My Mac'},'rows':[{'port':6006,'local':46006,'state':'Forwarded','url':'http://127.0.0.1:46006/#scalars'}]}))
    with patch.object(monitor,'directory',return_value=home):
        assert monitor.links(6006)[0]['url']=='http://127.0.0.1:46006/#scalars'
        assert monitor.links(6006,'another Mac')==[]
        os.utime(response,(time.time()-61,time.time()-61));assert monitor.links(6006)==[]
    print('monitor registration, stale PID and actual URL acknowledgement passed')
