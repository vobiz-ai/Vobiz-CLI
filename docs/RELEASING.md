# Releasing the Vobiz CLI

A release is one tag. Pushing `vX.Y.Z` runs [`release.yml`](../.github/workflows/release.yml), which publishes every channel:

| Job | Publishes | Notes |
|---|---|---|
| `verify` | — | Tag matches `package.json`, `package-lock.json` and a `## [X.Y.Z]` section in `CHANGELOG.md`; `npm run check` passes |
| `npm` | `@vobiz/cli` on npm | Trusted publishing (OIDC) with provenance, in the `npm` environment. Prereleases use the `next` dist-tag |
| `binaries` | — | Single-executable builds on macOS arm64 (`macos-14`), macOS x64 (`macos-15-intel`), Linux x64 (`ubuntu-24.04`), Linux arm64 (`ubuntu-24.04-arm`), Windows x64 (`windows-2022`) |
| `github-release` | GitHub release | Archives, `SHA256SUMS`, build-provenance attestations, generated notes |
| `docker` | `ghcr.io/vobiz-ai/vobiz-cli` | `linux/amd64` + `linux/arm64`, tags `X.Y.Z` and `vX.Y.Z`; `:latest` only for the highest stable tag |
| `homebrew` | PR to `vobiz-ai/homebrew-tap` | Stable releases only; skipped with a notice until `TAP_PUSH_TOKEN` exists |
| `scoop` | `packaging/scoop/vobiz.json` on `main` | Stable releases only; opens a PR instead if the branch ruleset rejects the push |

The workflow runs only in `vobiz-ai/Vobiz-CLI` (never in the internal mirror) and only for tags.

## One-time setup (account owner)

- [ ] **npm trusted publisher.** On npmjs.com create or open `@vobiz/cli` → **Settings** → **Trusted publisher** → **GitHub Actions**: organization `vobiz-ai`, repository `Vobiz-CLI`, workflow `release.yml`, environment `npm`. No `NPM_TOKEN` secret is needed. Keep two-factor authentication required for the package. npm attaches a trusted publisher only to a package that exists: if `@vobiz/cli` is not on npm yet, publish a placeholder `0.0.0` once from a maintainer account with 2FA (`npm publish --access public` from a clean checkout with the version set to `0.0.0`), then add the trusted publisher and deprecate the placeholder.
- [ ] **`npm` environment.** In the repository, **Settings → Environments → New environment** `npm`. Optionally add required reviewers so every publish waits for one approval, and limit it to tags matching `v*.*.*`.
- [ ] **Homebrew tap.** Create the public repository `vobiz-ai/homebrew-tap` with a `Formula/` directory (copy `packaging/homebrew/vobiz.rb` there once). Users then run `brew install vobiz-ai/tap/vobiz`.
- [ ] **`TAP_PUSH_TOKEN`.** Create a fine-grained personal access token (or a GitHub App token) with access to `vobiz-ai/homebrew-tap` only: **Contents: read and write**, **Pull requests: read and write**. Save it as the repository secret `TAP_PUSH_TOKEN` in `vobiz-ai/Vobiz-CLI`. Rotate it yearly.
- [ ] **GHCR package.** After the first release, open the `vobiz-cli` package under the `vobiz-ai` organization → **Package settings**: set visibility to **Public** and link it to `vobiz-ai/Vobiz-CLI`.
- [ ] **Branch ruleset on `main`.** Require the `ci` status check, linear history and signed tags. Add **GitHub Actions** to the bypass list if the Scoop job should commit directly; otherwise it opens a PR for a maintainer to merge.
- [ ] **Code scanning.** Enable GitHub code scanning so `codeql.yml` and `scorecard.yml` can upload results.

## Release steps

1. Make sure `main` is green and up to date: `git switch main && git pull --rebase`.
2. Pick the version (semver; `0.x` may break between minors). Bump it without creating a tag:

   ```bash
   npm version 0.2.0 --no-git-tag-version
   ```

3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [0.2.0] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]` above it, and update the compare links at the bottom.
4. Regenerate and check everything:

   ```bash
   npm run check
   npm run docs:commands
   git diff --exit-code docs/COMMANDS.md || git add docs/COMMANDS.md
   ```

5. Commit and open a PR (`chore: release 0.2.0`), wait for `ci`, merge it.
6. Tag the merge commit and push the tag:

   ```bash
   git switch main && git pull --rebase
   git tag -s v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

7. Watch **Actions → Release**. Approve the `npm` environment if it has reviewers.
8. Check the results:

   ```bash
   npm view @vobiz/cli@0.2.0 version
   gh release view v0.2.0 -R vobiz-ai/Vobiz-CLI
   docker run --rm ghcr.io/vobiz-ai/vobiz-cli:0.2.0 --version
   curl -fsSL https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.sh | VOBIZ_INSTALL_DIR=/tmp/vobiz-check sh && /tmp/vobiz-check/vobiz --version
   ```

9. Merge the Homebrew tap PR (and the Scoop PR, if the job opened one), then `brew install vobiz-ai/tap/vobiz && vobiz --version`.

## Prereleases

Tag `v0.3.0-rc.1` (with the same version in `package.json`). npm publishes under `next`, the GitHub release is marked as a prerelease, the Docker image gets `0.3.0-rc.1` and `v0.3.0-rc.1` only, and Homebrew and Scoop are skipped.

## Re-running or fixing a release

- A failed job can be re-run from the Actions page; npm and GHCR publishes are idempotent per version (npm refuses a second publish of the same version).
- To move `:latest` by hand, run **Release** from the tag with **latest** ticked. It still only moves for the highest stable tag.
- npm versions cannot be replaced. To fix a broken release, publish a new patch version; deprecate the bad one with `npm deprecate @vobiz/cli@X.Y.Z "<reason>"`.

## Build artifacts locally

```bash
npm run build && npm run build:assets   # dist/, completions/, man/
npm run build:sea                      # bin/vobiz-<version>-<os>-<arch>, archive, SHA256SUMS (current platform)
docker build -t vobiz-cli .            # the image
node scripts/update-homebrew-formula.mjs --version X.Y.Z --sums bin/SHA256SUMS   # formula and Scoop manifest
```

The SEA build bundles `dist/` with esbuild (run through `npx`, so it is not a dependency), embeds `package.json` and `spec/*.yaml` as SEA assets, and injects the blob with `postject`. macOS binaries are signed ad hoc; Windows binaries are unsigned.
