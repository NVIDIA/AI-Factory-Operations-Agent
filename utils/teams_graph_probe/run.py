# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Run one isolated Teams login/send probe using an owner-only local credential file.

Secret values travel over SSH stdin and kubectl stdin, never command arguments or logs.
All three temporary resources are deleted using UID preconditions after evidence capture.
Default mode verifies User.Read only; --send additionally requires a recipient GUID.
This is a one-shot diagnostic for an approved password flow, not a Teams channel.
"""
from pathlib import Path
import argparse
import datetime as dt
import json
import os
import shlex
import stat
import subprocess
import tempfile
import uuid
import re

HERE = Path(__file__).resolve().parent

REMOTE = r'''
from pathlib import Path
import base64,json,subprocess,sys,time,datetime,urllib.parse
payload=json.load(sys.stdin);creds=payload['credentials'];run_id=payload['runId']
ns=payload['namespace'];name='mosaic-'+run_id
k=[str(Path(payload['kubectl']).expanduser()),'--context',payload['context']]
labels={'mosaic-test':'teams-secret','mosaic-test-run':run_id,'mosaic-test-owner':payload['ownerToken']}
secret_json=json.dumps(creds,ensure_ascii=False).encode()
secret_encoded=base64.b64encode(secret_json).decode()
hidden=[secret_json.decode(),secret_encoded]
for value in [creds['password'],creds.get('clientSecret','')]:
 if value:hidden.extend([value,json.dumps(value)[1:-1],urllib.parse.quote(value,safe=''),urllib.parse.quote_plus(value)])
hidden.sort(key=len,reverse=True)
def clean(s):
 for x in hidden:
  if x:s=s.replace(x,'[REDACTED]')
 return s
def call(args,input=None,timeout=30):
 p=subprocess.run(k+args,input=input,capture_output=True,text=True,timeout=timeout)
 return {'exit':p.returncode,'stdout':clean(p.stdout),'stderr':clean(p.stderr)}
secret={'apiVersion':'v1','kind':'Secret','metadata':{'name':name,'namespace':ns,'labels':labels},
 'type':'Opaque','data':{'credentials.json':secret_encoded}}
config={'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':name,'namespace':ns,'labels':labels},
 'data':{'probe.cjs':payload['script']}}
pod={'apiVersion':'v1','kind':'Pod','metadata':{'name':name,'namespace':ns,'labels':labels},'spec':{
 'serviceAccountName':payload['serviceAccount'],'automountServiceAccountToken':False,'restartPolicy':'Never',
 'activeDeadlineSeconds':180,'terminationGracePeriodSeconds':5,
 'securityContext':{'runAsNonRoot':True,'runAsUser':1000,'runAsGroup':1000,'fsGroup':1000,'seccompProfile':{'type':'RuntimeDefault'}},
 'containers':[{'name':'probe','image':payload['image'],'imagePullPolicy':'IfNotPresent',
  'command':['node','/probe/probe.cjs'],'env':[{'name':'MOSAIC_TEST_RUN_ID','value':run_id},
    {'name':'MOSAIC_TEST_PROBE_MODE','value':payload['probeMode']},
    {'name':'MOSAIC_TEAMS_RECIPIENT_ID','value':payload['recipientId']}],
  'securityContext':{'allowPrivilegeEscalation':False,'readOnlyRootFilesystem':True,'capabilities':{'drop':['ALL']}},
  'resources':{'requests':{'cpu':'20m','memory':'64Mi'},'limits':{'cpu':'500m','memory':'256Mi'}},
  'volumeMounts':[{'name':'credentials','mountPath':'/var/run/mosaic-teams','readOnly':True},
   {'name':'script','mountPath':'/probe','readOnly':True}]}],
 'volumes':[{'name':'credentials','secret':{'secretName':name,'defaultMode':0o440}},
  {'name':'script','configMap':{'name':name}}]}}
manifest={'apiVersion':'v1','kind':'List','items':[secret,config,pod]}
result={'runId':run_id,'context':payload['context'],'namespace':ns,'resourceName':name,
 'probeMode':payload['probeMode'],'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'passwordResetPerformed':False,
 'automaticRotationEnabled':False,'originalOpenClawDeploymentModified':False,
 'resources':[],'samples':[],'probeEvents':[],'cleanup':[]}
try:
 # Do not overwrite an existing object, even though this timestamped name is unique.
 for kind in ['secret','configmap','pod']:
  check=call(['-n',ns,'get',kind,name,'--ignore-not-found','-o','name'])
  if check['exit'] or check['stdout'].strip():raise RuntimeError('resource_exists_or_lookup_failed')
 result['serverDryRun']=call(['create','--dry-run=server','-f','-'],json.dumps(manifest))
 if result['serverDryRun']['exit']:raise RuntimeError('server_dry_run_failed')
 result['create']=call(['create','-f','-'],json.dumps(manifest))
 discovery_failure=None
 for kind in ['secret','configmap','pod']:
  r=call(['-n',ns,'get',kind,name,'--ignore-not-found','-o','json'])
  if r['exit']:
   discovery_failure='resource_lookup_failed'
   continue
  if r['exit']==0 and r['stdout'].strip():
   obj=json.loads(r['stdout']);meta=obj.get('metadata',{})
   if meta.get('labels',{}).get('mosaic-test-owner')!=payload['ownerToken']:
    discovery_failure='resource_ownership_mismatch'
    continue
   result['resources'].append({'kind':kind,'name':name,'uid':meta['uid']})
 if discovery_failure:raise RuntimeError(discovery_failure)
 if result['create']['exit']:raise RuntimeError('resource_creation_failed')
 deadline=time.monotonic()+195
 while time.monotonic()<deadline:
  p=call(['-n',ns,'get','pod',name,'-o','json'])
  if p['exit']:raise RuntimeError('pod_observation_failed')
  obj=json.loads(p['stdout']);status=obj.get('status',{})
  result['samples'].append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
   'phase':status.get('phase'),'conditions':status.get('conditions',[]),
   'containerStatuses':status.get('containerStatuses',[])})
  if status.get('phase') in ['Succeeded','Failed']:break
  time.sleep(2)
 result['podPhase']=result['samples'][-1]['phase']
 logs=call(['-n',ns,'logs',name,'-c','probe'])
 result['logsExit']=logs['exit'];result['logsStderr']=logs['stderr']
 for line in logs['stdout'].splitlines():
  try:result['probeEvents'].append(json.loads(line))
  except ValueError:result.setdefault('otherLogs',[]).append(line)
 expected_stage='identity_verified' if payload['probeMode']=='identity' else 'sent'
 result['success']=result['podPhase']=='Succeeded' and any(e.get('stage')==expected_stage for e in result['probeEvents'])
except Exception as error:
 result['success']=False
 result['failure']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
finally:
 collections={'pod':'pods','configmap':'configmaps','secret':'secrets'}
 # Keep discovery and deletion scoped to this exact run's recorded object UIDs.
 for item in reversed(result['resources']):
  url=f"/api/v1/namespaces/{ns}/{collections[item['kind']]}/{item['name']}"
  options={'apiVersion':'v1','kind':'DeleteOptions','preconditions':{'uid':item['uid']},'gracePeriodSeconds':0}
  try:deletion=call(['delete','--raw',url,'-f','-'],json.dumps(options))
  except Exception as error:deletion={'exit':1,'stderr':type(error).__name__}
  result['cleanup'].append({'kind':item['kind'],'name':item['name'],'uid':item['uid'],'deleteExit':deletion['exit'],
   'stderr':deletion['stderr']})
 if any(item['deleteExit'] for item in result['cleanup']):result['success']=False
 result['completedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
print(json.dumps(result,ensure_ascii=False))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh-target', required=True, help='SSH target using an existing key or SSH agent.')
    parser.add_argument('--context', required=True, help='Explicit remote Kubernetes context.')
    parser.add_argument('--namespace', default='mosaic')
    parser.add_argument('--service-account', default='openclaw')
    parser.add_argument('--remote-kubectl', default='~/.local/bin/kubectl')
    parser.add_argument('--image', default='ghcr.io/openclaw/openclaw:2026.6.10')
    parser.add_argument('--credentials-file', type=Path, default=Path.home()/'.config/mosaic/credentials/teams-service-account.env')
    parser.add_argument('--output-dir', type=Path, default=Path(tempfile.gettempdir())/'mosaic-teams-probe')
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--identity-only', action='store_true', help='Default: verify User.Read and /me without chat requests.')
    mode.add_argument('--send', action='store_true', help='Attempt exactly one test message; requires --recipient-id.')
    parser.add_argument('--recipient-id', default='', help='Entra recipient GUID; avoids requesting directory lookup permission.')
    args = parser.parse_args()
    if args.ssh_target.startswith('-') or re.search(r'\s',args.ssh_target):
        parser.error('SSH target must be one non-option argument.')
    if not args.context.strip():
        parser.error('Kubernetes context must be explicit and nonempty.')
    for name in [args.namespace,args.service_account]:
        if not re.fullmatch(r'[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?',name):
            parser.error('Namespace and ServiceAccount must be DNS labels.')
    if args.send and not re.fullmatch(r'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}',args.recipient_id):
        parser.error('--send requires a recipient GUID.')
    credential = args.credentials_file.expanduser()
    info=credential.stat()
    if credential.is_symlink() or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077 or info.st_uid != os.getuid():
        raise SystemExit('Credential file must be a private regular file.')
    values = {}
    for line in credential.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if separator:
            values[key.strip()] = value
    creds = {'username': values.get('TEAMS_USERNAME', '').strip(),
             'password': values.get('TEAMS_PASSWORD', ''),
             'clientId': values.get('TEAMS_CLIENT_ID', '').strip(),
             'tenantId': values.get('TEAMS_TENANT_ID', '').strip() or 'organizations',
             'clientSecret': values.get('TEAMS_CLIENT_SECRET', '')}
    if any(not creds[key] for key in ['username', 'password', 'clientId']):
        raise SystemExit('Credential input is incomplete; nothing deployed.')
    os.umask(0o077)
    out=args.output_dir.expanduser();out.mkdir(parents=True,exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dt%H%M%Sz')
    run_id = ('teams-secret-' if args.send else 'teams-identity-') + stamp + '-' + uuid.uuid4().hex[:6]
    payload = {'runId': run_id, 'credentials': creds, 'probeMode': 'send' if args.send else 'identity',
               'context':args.context,'namespace':args.namespace,'serviceAccount':args.service_account,
               'kubectl':args.remote_kubectl,'image':args.image,'recipientId':args.recipient_id,
               'ownerToken':uuid.uuid4().hex,'script': (HERE / 'probe.cjs').read_text()}
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                             '-o', 'ServerAliveInterval=15', args.ssh_target,
                             shlex.join(['python3', '-c', REMOTE])],
                            input=json.dumps(payload), capture_output=True, text=True, timeout=300)
    if result.returncode:
        # SSH's own diagnostics contain no credential payload; do not print stdin or remote input.
        (out / (run_id + '.ssh-stderr.log')).write_text(result.stderr)
        raise SystemExit('Remote probe failed; inspect private SSH diagnostics.')
    data = json.loads(result.stdout)
    for secret in [creds['password'], creds.get('clientSecret')]:
        if secret and secret in result.stdout:
            raise SystemExit('Sensitive output detected; evidence was not written.')
    (out / (run_id + '.json')).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    summary = {'runId': run_id, 'success': data['success'], 'podPhase': data.get('podPhase'),
               'probeEvents': data['probeEvents'], 'cleanup': data['cleanup'],
               'evidenceFile': str(out / (run_id + '.json'))}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if data['success'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
