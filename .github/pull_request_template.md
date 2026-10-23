## What this changes

## How it was tested

- [ ] `npm run check` passes
- [ ] New or changed commands have tests (fake API: method, path, query, body) and stable `--help` snapshots
- [ ] Writes go through `requireConfirmation`, support `--dry-run`, and never print a token
- [ ] Every API call comes from an operation in `spec/`; anything the spec lacks is described above
- [ ] `npm run docs:commands` was run, and `README.md` / `CHANGELOG.md` are updated
