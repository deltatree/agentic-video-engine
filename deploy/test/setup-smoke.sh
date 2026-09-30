#!/usr/bin/env bash
# Rauchprobe des Wrappers `openvideo` nach `npm run setup` (ADR 0029), für docker, podman und kubernetes.
#
# Aufruf: bash deploy/test/setup-smoke.sh <wrapper> [--video]
#   <wrapper>  Pfad des installierten Wrappers (z. B. ~/.local/bin/openvideo)
#   --video    zusätzlich ein MP4 rendern und mit ffprobe prüfen (falls ffprobe auf dem Host liegt)
#
# Prüft: --help, doctor (Laufzeit-Zeile), create, validate, render-frame (PNG gehört dem Aufrufer),
# MCP-Handshake über stdio (initialize, tools/list, Ende von stdin → Exit-Code 0) und Studio/API mit Token
# (serve bzw. unter Kubernetes studio per port-forward). Die Laufzeit steht in runtime.json.
set -euo pipefail

wrapper="${1:?usage: setup-smoke.sh <wrapper> [--video]}"
video="${2:-}"
config="${OPENVIDEO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/openvideo}"
runtime="$(node -p "require('${config}/runtime.json').runtime")"
work="$(mktemp -d)"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT
log() { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

log "runtime ${runtime}, wrapper ${wrapper}"
"$wrapper" --help | grep -q 'Usage: openvideo' || fail "--help"
"$wrapper" doctor > "$work/doctor.txt" || true
grep -q "runtime .*${runtime}" "$work/doctor.txt" || { cat "$work/doctor.txt"; fail "doctor does not name the runtime ${runtime}"; }
grep -Eq '^✓ browser' "$work/doctor.txt" || fail "doctor: browser"
grep -Eq '^✓ ffmpeg' "$work/doctor.txt" || fail "doctor: ffmpeg"

mkdir -p "$work/projects"
cd "$work/projects"
log "create, validate, render-frame"
"$wrapper" create "hello world" > /dev/null
cd "hello world"
"$wrapper" validate
"$wrapper" render-frame --frame 1s --out out/frame.png
[ -s out/frame.png ] || fail "out/frame.png missing"
[ "$(head -c 8 out/frame.png | od -An -tx1 | tr -d ' \n')" = 89504e470d0a1a0a ] || fail "out/frame.png is no PNG"
[ "$(stat -c %u out/frame.png 2>/dev/null || stat -f %u out/frame.png)" = "$(id -u)" ] || fail "out/frame.png does not belong to $(id -u)"

if [ "$video" = --video ]; then
  log "render mp4"
  "$wrapper" render --format mp4 --out out/hello.mp4 > "$work/render.txt" 2>&1 || { tail -20 "$work/render.txt"; fail "render"; }
  if command -v ffprobe > /dev/null; then
    duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 out/hello.mp4)"
    echo "   duration ${duration}s"
    [ "${duration%%.*}" -ge 4 ] || fail "video too short: ${duration}"
  else
    [ -s out/hello.mp4 ] || fail "out/hello.mp4 missing"
  fi
fi

log "MCP handshake"
cat > "$work/mcp.mjs" <<'EOF'
import { spawn } from 'node:child_process';
const [wrapper, ...args] = process.argv.slice(2);
const child = spawn(wrapper, ['mcp', ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
child.stdout.on('data', (d) => { buf += d; });
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const timer = setTimeout(() => { console.error('MCP timeout; output:', buf); process.exit(1); }, 120_000);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'setup-smoke', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const iv = setInterval(() => {
  if (!buf.split('\n').some((l) => l.includes('"id":2'))) return;
  clearInterval(iv);
  child.stdin.end();
}, 50);
child.on('exit', (code) => {
  clearTimeout(timer);
  const lines = buf.trim().split('\n').map((l) => JSON.parse(l));
  const tools = lines.find((l) => l.id === 2)?.result?.tools ?? [];
  console.log(`   server ${lines.find((l) => l.id === 1)?.result?.serverInfo?.name}, ${tools.length} tools, exit ${code}`);
  process.exit(code === 0 && tools.length > 0 ? 0 : 1);
});
EOF
node "$work/mcp.mjs" "$wrapper" --workspace "$work/ws" || fail "MCP handshake"

log "Studio/API with token"
token="$(sed -n 's/^OPENVIDEO_API_TOKEN=//p' "$config/api.env")"
[ -n "$token" ] || fail "no token in $config/api.env"
port=7788
if [ "$runtime" = kubernetes ]; then
  "$wrapper" studio > "$work/serve.log" 2>&1 &
else
  port=7798
  "$wrapper" serve --port "$port" --workspace "$work/ws" > "$work/serve.log" 2>&1 &
fi
pids+=($!)
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${port}/v1/health" > /dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${port}/v1/health" | grep -q '"ok":true' || { cat "$work/serve.log"; fail "health"; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/v1/operations")" = 401 ] || fail "API without token must answer 401"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" "http://127.0.0.1:${port}/v1/operations")" = 200 ] || fail "API with token"
grep -q "#token=" "$work/serve.log" || fail "no Studio URL with #token="
if ps -eo args | grep -F -- "$token" | grep -vq grep; then fail "the API token is visible in the process list"; fi
log "OK (${runtime})"
