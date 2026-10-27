#!/usr/bin/env python3
"""Dedicated Client Host startup: use upstream HTTP API; never authorize its Host.

Run as systemd ExecStartPost with a private log, credential directory and output
owner. The script does not log launch tokens, cookies, RPC payloads or responses.
It neither logs into an account nor selects a target, and sends no model tasks.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', required=True, type=int)
    parser.add_argument('--log', required=True, type=Path)
    parser.add_argument('--credential', required=True, type=Path)
    parser.add_argument('--owner', required=True)
    args = parser.parse_args()
    base = f'http://127.0.0.1:{args.port}'
    cookie = None
    # Only root-token exchange is retried while the process starts. Every RPC
    # mutation below is sent once, and a lost receipt fails the startup hook.
    for _ in range(50):
        try:
            tokens = re.findall(re.escape(base) + r'/\?token=([^\s]+)', args.log.read_text())
            if tokens:
                conn = http.client.HTTPConnection('127.0.0.1', args.port, timeout=3)
                conn.request('GET', '/?token=' + tokens[-1])
                response = conn.getresponse()
                if response.status == 303:
                    cookie = '; '.join(value.split(';', 1)[0] for key, value in response.getheaders() if key.lower() == 'set-cookie')
                response.read()
                conn.close()
                if cookie:
                    break
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.2)
    if not cookie:
        raise RuntimeError('Client Host launch authentication unavailable')

    def control(method, payload):
        conn = http.client.HTTPConnection('127.0.0.1', args.port, timeout=15)
        request_id = str(uuid.uuid4())
        conn.request('POST', '/ds-harness-remote/' + method, json.dumps({
            'type': 'client-request', 'rpcId': request_id, 'method': method, 'payload': payload,
        }), {'Content-Type': 'application/json', 'Cookie': cookie, 'Origin': base})
        response = conn.getresponse()
        body = json.loads(response.read(8 * 1024 * 1024))
        conn.close()
        if response.status != 200 or body.get('rpcId') != request_id or body.get('result', {}).get('ok') is not True:
            code = str(body.get('result', {}).get('error', {}).get('code', 'unknown'))
            raise RuntimeError('Dedicated Client Host control rejected: ' + method + '/' + code)
        return body['result']['value']

    status = None
    for _ in range(50):
        try:
            candidate = control('status', {})
            if candidate.get('identityReady') and candidate.get('host', {}).get('deviceId'):
                status = candidate
                break
        except (RuntimeError, ValueError, OSError, http.client.HTTPException):
            pass
        time.sleep(0.2)
    if status is None:
        raise RuntimeError('Dedicated Client Host plugin is not ready')
    # Upstream 0.5.18 starts a Host even with role=client. Its initial missing
    # authorization otherwise blocks device discovery. The official disable
    # action stops that Host; no Host credentials are created or granted.
    if status.get('host', {}).get('authorized'):
        raise RuntimeError('Dedicated Client unexpectedly has an authorized Host')
    control('host.authorization.set', {'enabled': False})
    after = control('status', {}).get('host', {})
    if after.get('authorized') or after.get('online') or after.get('error'):
        raise RuntimeError('Dedicated Host did not stop cleanly')

    owner = pwd.getpwnam(args.owner)
    if args.credential.is_symlink():
        raise RuntimeError('Credential destination must not be a symlink')
    temporary = args.credential.with_name('.credential-' + str(uuid.uuid4()) + '.tmp')
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump({'cookie': cookie}, output)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.chown(temporary, owner.pw_uid, owner.pw_gid)
        os.replace(temporary, args.credential)
    finally:
        temporary.unlink(missing_ok=True)
    print('Dedicated Client ready; local Host disabled; private credential refreshed')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Exceptions may contain authenticated request metadata; never print it.
        raise SystemExit('DSH_REMOTE_CLIENT_STARTUP_FAILED')
