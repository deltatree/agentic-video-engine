# Security

[Deutsche Fassung](SECURITY.de.md)

## Report a vulnerability

Please do not report security vulnerabilities as a public issue.
Use GitHub's private reporting instead:
**Security → Report a vulnerability** in this repository.

Describe in the report:

1. The affected version or commit.
2. The steps that show the vulnerability.
3. The impact, for example reading files or executing code.

We confirm receipt within 7 days.
We publish a fix with a note in the changelog.

## Supported versions

Security fixes are provided for the latest minor version.

## Security model in short

OpenVideo runs code that agents write. This code is untrusted.

| Input | Where it runs |
|---|---|
| TSX projects | In a Docker container without network, without capabilities, with memory and process limits (default `container`) |
| HTML layers with scripts | Only with explicit permission (`--trusted` or `OPENVIDEO_ALLOW_HTML_SCRIPTS=1`) **and** with the Chromium OS sandbox; otherwise blocked (`OV_BROWSER_NO_OS_SANDBOX`). The container image alone allows nothing. |
| Plugins (`settings.plugins`) | In the render process, only with `--trusted` or `OPENVIDEO_ALLOW_PLUGINS=1`; host services only with granted permissions (`OPENVIDEO_PLUGIN_PERMISSIONS`). Permissions are not a sandbox. |
| JSON projects | On the host; JSON contains no executable code |
| Asset URLs | Only public addresses; private, loopback and metadata addresses are blocked |

The mode `trusted-host` is **not** isolation. Use it only for your own code.

Without a token the HTTP API binds only to loopback addresses.
Set a token with `OPENVIDEO_API_TOKEN` for any other address.

Details are in `docs/adr/0008-nicht-vertrauenswuerdiger-code-nur-im-container.md` (German).

## Running in a cluster

The rules for Kubernetes are in `deploy/README.md` (section "Security") and in
`docs/adr/0023-remote-worker-schreiben-nur-unter-jobs-praefix.md`. In short:

- The coordinator separates the roles `submit` (API), `worker` and `metrics` (KEDA) with their own tokens.
  Tokens have at least 24 characters; it rejects placeholders (`REPLACE…`). Without a token it binds only to loopback.
- Workers have no S3 admin rights. They read `inputs/` and write only `jobs/<jobId>/frames/`.
  The API accepts only frames with the prefix of its own job and checks the SHA-256 of every frame.
- `complete`/`fail` are valid only with a valid lease. Requests are limited to 64 MiB, finished jobs expire.
- FFmpeg reads inputs only via `file`/`pipe` and only from a list of allowed containers (no playlists,
  no `concat`). Chromium, Blender, Piper and whisper.cpp inherit no tokens or S3 keys.
- The Studio sets `Content-Security-Policy` with `frame-ancestors 'none'` and `Referrer-Policy: no-referrer`
  and takes the token only from `#token=` (never from `?token=`).
- Connections inside the cluster are plain HTTP. For encryption we recommend a service mesh with
  mTLS or WireGuard in the CNI; NetworkPolicies need a CNI that enforces them.

## Supply chain

- GitHub Actions are pinned by commit SHA; Dependabot keeps actions, npm and base images up to date
  (`.github/dependabot.yml`).
- Every workflow job has only the permissions it needs (`permissions` per job).
- Downloads in CI and images (FFmpeg, Blender, Chromium) are checked against fixed SHA-256 checksums.
