#!/bin/sh
# The real DSH Desktop: hot-reload this (linked) plugin and install the hc template.
#   scripts/desktop.sh reload     bump herdr-bridge's reloadToken in the Desktop profile patch
#                                 (HMR then reloads the plugin; other entries are left as they are)
#   scripts/desktop.sh template   install the hc template `dsh` (via the dsh-hc launcher the plugin writes)
#   scripts/desktop.sh log        tail the plugin log
# The first reload backs the patch file up to cordis.patch.yml.herdr-bridge.bak.
set -eu
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
# DSH_PROFILE_NAME selects another profile (scripts/dev.sh uses it for the isolated `web` profile).
PATCH=$DSH_HOME/profiles/${DSH_PROFILE_NAME:-desktop}/cordis.patch.yml

case "${1:-}" in
reload)
  [ -f "$PATCH.herdr-bridge.bak" ] || cp -p "$PATCH" "$PATCH.herdr-bridge.bak"
  python3 -I - "$PATCH" <<'EOF'
import os, re, sys, time
path = sys.argv[1]
text = open(path).read()
token = f"{time.time_ns()}"
lines = text.splitlines(keepends=True)
start = next((i for i, l in enumerate(lines) if re.match(r"^- id: herdr-bridge\s*$", l)), None)
if start is None:
    if text.strip() in ("", "[]"):
        text = ""
    elif not text.endswith("\n"):
        text += "\n"
    text += f"- id: herdr-bridge\n  config:\n    reloadToken: {token}\n"
else:
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("- ")), len(lines))
    block = lines[start:end]
    if any(re.match(r"^    reloadToken:", l) for l in block):
        block = [f"    reloadToken: {token}\n" if re.match(r"^    reloadToken:", l) else l for l in block]
    elif any(re.match(r"^  config:\s*$", l) for l in block):
        at = next(i for i, l in enumerate(block) if re.match(r"^  config:\s*$", l))
        block.insert(at + 1, f"    reloadToken: {token}\n")
    else:
        block.append(f"  config:\n    reloadToken: {token}\n")
    text = "".join(lines[:start] + block + lines[end:])
tmp = path + ".tmp"
with open(tmp, "w") as f:
    f.write(text)
os.chmod(tmp, os.stat(path).st_mode & 0o777)
os.replace(tmp, path)
EOF
  ;;
template)
  "$DSH_HOME/herdr-bridge/bin/dsh-hc" install-template
  ;;
log) tail -n "${2:-20}" "$DSH_HOME/herdr-bridge/bridge.log" ;;
*) echo "usage: $0 reload|template|log [n]" >&2; exit 2 ;;
esac
