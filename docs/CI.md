# Use the Vobiz CLI in CI

The Vobiz CLI runs unattended in any CI system. Three rules make it reliable:

1. **Credentials come from secrets.** Store your Auth ID and Auth Token as CI secrets and expose them as `VOBIZ_AUTH_ID` and `VOBIZ_AUTH_TOKEN`. Never pass them as `--auth-token` flags: CI logs and shell history keep flags.
2. **Writes need `--yes`.** Without a terminal, any command that would ask for confirmation exits with code `6` unless you pass `--yes` (or set `VOBIZ_YES=1`). Use `--dry-run` in pull-request pipelines to show what would happen.
3. **Read JSON, branch on exit codes.** Pass `--output json` and parse stdout. Errors arrive on stderr as one JSON line `{"error","message","status","retryable","hint"}` with a stable [exit code](../README.md#exit-codes).

The update check is skipped automatically when `CI` is set. Pin the CLI version so a new release never changes a pipeline by surprise.

If your account restricts API access by IP address, allow your runners' addresses. See [IP whitelisting](https://www.vobiz.ai/docs/concepts/ip-whitelisting).

## GitHub Actions

Add `VOBIZ_AUTH_ID` and `VOBIZ_AUTH_TOKEN` under **Settings → Secrets and variables → Actions**.

```yaml
name: Vobiz numbers report
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  report:
    runs-on: ubuntu-latest
    env:
      VOBIZ_AUTH_ID: ${{ secrets.VOBIZ_AUTH_ID }}
      VOBIZ_AUTH_TOKEN: ${{ secrets.VOBIZ_AUTH_TOKEN }}
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: npm install --global @vobiz/cli@0.1.0
      - run: vobiz whoami --output json
      - name: Balance and numbers
        run: |
          vobiz account balance --output json > balance.json
          vobiz numbers list --all --output json > numbers.json
          jq -r '.available_balance' balance.json
```

A deploy step that changes the account confirms explicitly and stops on any failure:

```yaml
      - name: Route the support number to the production trunk
        run: |
          set -euo pipefail
          vobiz numbers assign "$NUMBER" --trunk "$TRUNK_ID" --dry-run --output json
          vobiz numbers assign "$NUMBER" --trunk "$TRUNK_ID" --yes --output json
        env:
          NUMBER: ${{ vars.VOBIZ_SUPPORT_NUMBER }}
          TRUNK_ID: ${{ vars.VOBIZ_TRUNK_ID }}
```

Pin every action to a commit SHA, as above, so a moved tag cannot change your pipeline.

### With Docker instead of Node.js

```yaml
      - run: |
          docker run --rm -e VOBIZ_AUTH_ID -e VOBIZ_AUTH_TOKEN \
            ghcr.io/vobiz-ai/vobiz-cli:0.1.0 cdr list --from 7d --output json > cdrs.json
```

## GitLab CI

Add `VOBIZ_AUTH_ID` and `VOBIZ_AUTH_TOKEN` under **Settings → CI/CD → Variables**, marked **Masked** and **Protected**.

```yaml
vobiz-report:
  image:
    name: ghcr.io/vobiz-ai/vobiz-cli:0.1.0
    # The image's entrypoint is the CLI; clear it so GitLab can run a shell script.
    entrypoint: [""]
  script:
    - node /app/dist/index.js whoami --output json
    - node /app/dist/index.js cdr list --from 7d --output json > cdrs.json
  artifacts:
    paths: [cdrs.json]
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
```

Or with a Node.js image:

```yaml
vobiz-numbers:
  image: node:24
  script:
    - npm install --global @vobiz/cli@0.1.0
    - vobiz numbers list --output json --quiet
```

## Jenkins

Store the credentials as a **Username with password** credential (`vobiz-api`: username = Auth ID, password = Auth Token).

```groovy
pipeline {
  agent { docker { image 'node:24' } }
  stages {
    stage('Install') {
      steps { sh 'npm install --global @vobiz/cli@0.1.0' }
    }
    stage('Report') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'vobiz-api',
                                          usernameVariable: 'VOBIZ_AUTH_ID',
                                          passwordVariable: 'VOBIZ_AUTH_TOKEN')]) {
          sh '''
            set -eu
            vobiz whoami --output json
            vobiz cdr recent --output json > cdrs.json
          '''
        }
        archiveArtifacts artifacts: 'cdrs.json'
      }
    }
  }
}
```

Jenkins masks the credential values in the console log. Keep using single-quoted `sh '''…'''` blocks so Groovy never interpolates the secrets.

## Handling results in shell

```bash
set +e
vobiz calls create --from "$FROM" --to "$TO" --answer-url "$ANSWER_URL" --yes --output json > call.json
code=$?
set -e
case "$code" in
  0) jq -r '.request_uuid' call.json ;;
  5) echo "rate limited or insufficient balance; try later" >&2; exit 1 ;;
  7) echo "outcome unknown: check 'vobiz calls list' before retrying" >&2; exit 1 ;;
  *) exit "$code" ;;
esac
```

Calls and messages reach real people and are billed. Keep them out of pull-request pipelines, and gate them behind a protected branch or a manual approval.
