# Security policy

Please report vulnerabilities privately by email to **security@vobiz.ai** (or support@vobiz.ai), or use the **Report a vulnerability** button on this repository's Security tab. Do not open a public issue. Include steps to reproduce and the affected version (`vobiz --version`). We acknowledge reports within 3 business days.

We aim to ship a fix within 90 days of the report and coordinate disclosure with you; fixed issues are published as GitHub security advisories, with a CVE when one applies. We will not pursue or support legal action against good-faith research that respects user privacy, avoids accounts and data that are not your own, and gives us reasonable time to fix before disclosure.

Supported versions: the latest minor release of `@vobiz/cli`.

Design notes for reviewers:

- Credentials come from flags, the environment (`VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`) or a saved profile, in that order. Profiles are stored in a file with mode 0600 inside a 0700 directory. Tokens are never printed or logged: output and debug logs redact every key whose name ends in `token`, `secret`, `password`, `credential(s)`, `api_key` or `private_key` (and `pin`, `authorization`), and error text has the active token and any secret flag values scrubbed.
- Every request is scoped to the authenticated account. No command accepts an account ID.
- Commands that spend money, contact people or change the account require confirmation (`--yes` when there is no terminal), support `--dry-run`, and are never retried automatically.
- Call-control URLs must be https or wss (http only for localhost with an explicit flag).
- Releases are built in GitHub Actions from the tagged commit: npm packages carry provenance, release archives carry `SHA256SUMS` and build-provenance attestations, and the Docker image is built from a digest-pinned base and runs as a non-root user without npm. Every GitHub Action is pinned to a commit SHA, and each job gets only the token permissions it needs.
