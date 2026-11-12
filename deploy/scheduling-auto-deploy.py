#!/usr/bin/env python3
"""Poll this repo's main branch; ask Coolify to build each new commit once.

Runs on Serverdude from scheduling-auto-deploy.timer, the same way Big Dog
Flips deploys. Coolify's API is only reachable on the server, so nothing is
exposed to GitHub and no GitHub credentials are needed.

Configuration (environment, see scheduling-auto-deploy.service):
  COOLIFY_APP_UUID    the scheduling application's UUID in Coolify (required)
  COOLIFY_TOKEN_FILE  file holding a Coolify API token with read and deploy
                      permissions
"""
import json
import os
from pathlib import Path
import subprocess
import urllib.request

APP = os.environ['COOLIFY_APP_UUID']
REPO = os.environ.get('DEPLOY_REPO', 'https://github.com/babygramps/scheduling.git')
BRANCH = os.environ.get('DEPLOY_BRANCH', 'main')
BASE = os.environ.get('COOLIFY_API', 'http://127.0.0.1:8000/api/v1')
TOKEN = Path(os.environ.get('COOLIFY_TOKEN_FILE', '/home/servy/.config/big-dog-flips/coolify-token'))


def api(path, method='GET'):
    request = urllib.request.Request(BASE + path, method=method, headers={
        'Authorization': 'Bearer ' + TOKEN.read_text().strip(),
        'Accept': 'application/json',
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def main():
    result = subprocess.run(
        ['git', 'ls-remote', REPO, 'refs/heads/' + BRANCH],
        check=True, capture_output=True, text=True, timeout=30,
        env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
    )
    commit = result.stdout.split()[0]
    deployments = api('/deployments/applications/' + APP)['deployments']
    if any(d['status'] in ('queued', 'in_progress') for d in deployments):
        print('Deployment already queued or running.', flush=True)
        return
    # Do not loop on broken commits; retry manually in Coolify or push a fix.
    latest = max(deployments, key=lambda d: d['id'], default=None)
    if latest and latest['commit'] == commit:
        print(f"{BRANCH} {commit[:12]}: {latest['status']}", flush=True)
        return
    response = api('/deploy?uuid=' + APP, method='POST')
    if not response.get('deployments'):
        raise RuntimeError('Coolify did not return a deployment: ' + str(response))
    print(f'New {BRANCH} {commit}; requested deployment: {response}', flush=True)


if __name__ == '__main__':
    main()
