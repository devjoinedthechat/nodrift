# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include the nodrift version, a minimal config or steps to reproduce, and the impact you observed. You can expect an acknowledgement within a few days and a fix or mitigation plan once the report is confirmed.

## Supported versions

Security fixes are released for the latest minor version.

## Security model

nodrift reads on-chain state and never signs or sends transactions. It treats config files as untrusted data, because in CI they often come from pull requests:

- Substitution supports environment variables and file reads only. There is no command execution and no expression evaluation.
- `${file:...}`, ABI paths and `imports` must resolve (after following symlinks) inside the working directory or the config file's own directory.
- RPC URLs often contain API keys, so reports and errors only ever show the host.
- A check that cannot be evaluated is reported as an error with a non-zero exit code, never as a pass.

Things nodrift does not protect against:

- A malicious or compromised RPC endpoint can return false state. Use an endpoint you trust, or compare several.
- Environment variables referenced by a config can appear in reports (for example as expected values). Do not reference secrets in configs, and do not expose secrets to workflows that run untrusted pull requests.
