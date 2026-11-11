#!/bin/sh
# End-to-end checks against the isolated dev environment (scripts/dev.sh up first).
# Drives DSH only through hc and dsh-hc, the way a Herdr agent would; the mock LLM scripts the
# replies. UI-side checks (Desktop-origin sessions, Desktop answering, /herdr) are in e2e-ui.sh.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
eval "$("$ROOT/scripts/dev.sh" env)"
WORK=${DSH_BRIDGE_ISO:-/tmp/dsh-iso}/e2e-proj
mkdir -p "$WORK/sub" && cd "$WORK" || exit 1
RUN=$(date +%s)
FAILED=0

state() { field "$1" state; }
field() { hc get "$1" --json 2>/dev/null | python3 -I -c 'import json,sys;s=json.load(sys.stdin).get("status") or {};print(s.get(sys.argv[1],""))' "$2"; }
address() { hc get "$1" --json 2>/dev/null | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["address"])'; }
label() { hc get "$1" --json 2>/dev/null | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("labels",{}).get(sys.argv[1],""))' "$2"; }
# Live terminals reporting as DSH (`hc ls --json` has no labels, but shows the reporting app as agent).
dsh_terminals() { hc ls --json | python3 -I -c 'import json,sys;[print(t["address"]) for t in json.load(sys.stdin)["terminals"] if t.get("agent")=="dsh"]'; }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; FAILED=1; fi
}
contains() { # contains <label> <terminal> <text>
  if hc read "$2" --lines 300 2>/dev/null | grep -qF -- "$3"; then echo "ok   $1"; else echo "FAIL $1: '$3' not on screen"; FAILED=1; fi
}

check "the plugin installs the hc template itself" "$(grep -c '^generator: dsh-herdr-bridge$' "$XDG_CONFIG_HOME/herdr-core/templates/dsh.md" 2>/dev/null)" 1

T=e2e-$RUN
hc run --bg --name "$T" dsh "hello [[e2e]]" >/dev/null
hc wait "$T" --timeout 60 >/dev/null
check "hc-origin session finishes its first task" "$(state "$T")" done
contains "transcript shows the reply" "$T" "MOCK-REPLY: hello [[e2e]]"
check "7501 title follows the DSH session title" "$(field "$T" title)" "Mock title"
check "terminal title (OSC 2) follows the session title" "$(hc get "$T" --json | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("title",""))')" "Mock title"
check "dsh.title label follows the session title" "$(label "$T" dsh.title)" "Mock title"
SID=$(label "$T" dsh.session)
check "dsh.session label is set" "$(printf %s "$SID" | cut -c1-8)" session-

hc send --wait --timeout 60 "$T" "second [[e2e]]" >/dev/null
check "send --wait runs a second turn" "$(state "$T")" done
contains "second reply on screen" "$T" "MOCK-REPLY: second [[e2e]]"

hc send "$T" "slow [[slow]]" >/dev/null; sleep 1
check "slow turn is working" "$(state "$T")" working
hc interrupt "$T" >/dev/null
check "interrupt returns to idle" "$(state "$T")" idle
contains "cancel is shown" "$T" "✻ cancelled"

hc send --wait --timeout 60 "$T" "boom [[fail]]" >/dev/null
check "model failure reports error" "$(state "$T")" error
contains "error is shown" "$T" "✻ error"
contains "the whole error is shown" "$T" "end-of-error"

A=e2e-a-$RUN
hc run --bg --name "$A" dsh "needs approval [[approve]]" >/dev/null
hc wait "$A" --timeout 60 >/dev/null
check "approval request reports blocked" "$(state "$A")" blocked
if hc send "$A" "y" >/dev/null 2>&1; then check "hc refuses plain send while blocked" sent refused; else check "hc refuses plain send while blocked" refused refused; fi
hc send --force --wait --timeout 60 "$A" "y" >/dev/null
check "approval answered from hc (--force y)" "$(state "$A")" done
contains "approved command ran to the end" "$A" "approval flow finished"
rm -f /var/tmp/dsh-bridge-approval-probe

B=e2e-b-$RUN
hc run --bg --name "$B" dsh "needs approval again [[approve]]" >/dev/null
hc wait "$B" --timeout 60 >/dev/null
hc interrupt "$B" >/dev/null
check "interrupt while blocked returns to idle" "$(state "$B")" idle

Q=e2e-q-$RUN
hc run --bg --name "$Q" dsh "ask [[question]]" >/dev/null
hc wait "$Q" --timeout 60 >/dev/null
check "question reports blocked(question)" "$(state "$Q"):$(field "$Q" kind)" blocked:question
hc send --force --wait --timeout 60 "$Q" "2" >/dev/null
contains "question answered from hc by option number" "$Q" '"selected":["blue"]'

E=e2e-e-$RUN
hc run --bg --name "$E" dsh "env [[env]]" >/dev/null
hc wait "$E" --timeout 60 >/dev/null
contains "the session's shell gets DSH_HC_TERMINAL = its hc address" "$E" "DSH_HC_TERMINAL=$(address "$E")"
contains "tool calls show their description and result" "$E" "⏺ bash show hc address"
# hc in the session's shell acts as the session's terminal, even though the test's own shell (and so
# dsh web) may carry another terminal's HC_TERMINAL_ID.
IN=e2e-in-$RUN
hc run --bg --name "$IN" sh -c 'printf "\033]7501;state=idle\033\\"; cat' >/dev/null
hc send --wait --timeout 60 "$E" "talk [[hc:$IN]]" >/dev/null
contains "a message the session sends with hc comes from its terminal" "$IN" "<hc from=\"$(address "$E") $E\">hi from dsh"
check "a helper it starts with hc is its child" "$(hc get "$IN-kid" --json | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("parent"))')" "$(address "$E")"
for t in "$IN" "$IN-kid"; do hc kill "$t" >/dev/null 2>&1; hc rm "$t" >/dev/null 2>&1; done
if grep -q '"bridge_skill": true' "${DSH_BRIDGE_ISO:-/tmp/dsh-iso}/mock.log"; then check "herdr-bridge skill reaches the model" yes yes; else check "herdr-bridge skill reaches the model" no yes; fi

# Discovery and takeover: dsh-hc ls finds the session; attach replays its conversation.
SHORT=$(printf %s "$SID" | sed 's/^session-//' | cut -c1-8)
if dsh-hc ls --days 1 | grep -q "^$SHORT"; then check "dsh-hc ls lists recent sessions" yes yes; else check "dsh-hc ls lists recent sessions" no yes; fi
V=e2e-v-$RUN
hc run --bg --name "$V" dsh-hc attach "$SHORT" >/dev/null; sleep 2
contains "attach replays the earlier conversation" "$V" "MOCK-REPLY: second [[e2e]]"
check "attached terminal reports the session status" "$(state "$V")" error
hc send --wait --timeout 60 "$V" "from the attached terminal [[e2e]]" >/dev/null
contains "a prompt from one terminal shows in the other" "$T" "MOCK-REPLY: from the attached terminal [[e2e]]"

# A subfolder of a Workspace becomes an ungrouped session in that folder, not a new Workspace.
S=e2e-s-$RUN
(cd "$WORK/sub" && hc run --bg --name "$S" dsh "in a subfolder [[e2e]]" >/dev/null)
hc wait "$S" --timeout 60 >/dev/null
SSID=$(label "$S" dsh.session)
SCWD=$(dsh-hc ls --days 1 --json | python3 -I -c 'import json,sys;print(next((i["cwd"] for i in json.load(sys.stdin) if i["sessionId"]==sys.argv[1]),""))' "$SSID")
check "a subfolder session keeps its folder" "$(basename "$SCWD")" sub

# A reload drops the plugin's connections; the terminal stays, reconnects, and keeps its address.
F=e2e-f-$RUN
hc run --bg --name "$F" dsh "fails before the reload [[fail]]" >/dev/null
hc wait "$F" --timeout 60 >/dev/null
R=e2e-r-$RUN
hc run --bg --name "$R" dsh "running across a reload [[slow:12]]" >/dev/null; sleep 1
BEFORE=$(address "$R")
"$ROOT/scripts/dev.sh" reload; sleep 5
check "a terminal survives a plugin reload with the same address" "$(address "$R"):$(hc get "$R" --json | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["state"])')" "$BEFORE:live"
check "it still reports the running turn" "$(state "$R")" working
check "a finished session stays done across the reload" "$(state "$A")" done
check "a failed session stays error across the reload" "$(state "$F")" error
# Herdr clients write herdr.seen=<turn> for what a person looked at; like Claude Code, a seen
# error stays error until the next turn.
FTURN=$(hc get "$F" --json | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["turn"])')
hc label "$F" "herdr.seen=$FTURN" >/dev/null; sleep 1
check "an error seen in Herdr stays error" "$(state "$F")" error
hc wait "$R" --timeout 60 >/dev/null
check "and the turn finishes" "$(state "$R")" done
contains "the reconnect is visible" "$R" "⋯ reconnected"

# install-template also gives DSH a name and icon in Herdr App's program table, keeping the person's entries.
APPHOME=${DSH_BRIDGE_ISO:-/tmp/dsh-iso}/herdr-app-test
rm -rf "$APPHOME"; mkdir -p "$APPHOME"
printf '{"programs":{"mine":{"name":"Mine"}}}' > "$APPHOME/programs.json"
HERDR_APP_HOME=$APPHOME dsh-hc install-template >/dev/null
prog() { python3 -I -c 'import json,sys;p=json.load(open(sys.argv[1]))["programs"];print(p.get(sys.argv[2],{}).get("name",""))' "$APPHOME/programs.json" "$1"; }
check "install-template adds DSH to Herdr App's programs" "$(prog dsh):$(prog mine)" "DSH:Mine"
check "and installs its icon" "$([ -s "$APPHOME/icons/dsh-herdr-bridge.svg" ] && echo yes)" yes
python3 -I -c 'import json,sys;f=sys.argv[1];t=json.load(open(f));t["programs"]["dsh"]["name"]="My DSH";json.dump(t,open(f,"w"))' "$APPHOME/programs.json"
HERDR_APP_HOME=$APPHOME dsh-hc install-template >/dev/null
check "and keeps a dsh entry the person changed" "$(prog dsh)" "My DSH"
rm -rf "$APPHOME"
MINE=${DSH_BRIDGE_ISO:-/tmp/dsh-iso}/template-test
rm -rf "$MINE"; mkdir -p "$MINE/herdr-core/templates"
printf -- '---\ncommand: my-dsh\n---\n' > "$MINE/herdr-core/templates/dsh.md"
XDG_CONFIG_HOME=$MINE HERDR_APP_HOME=$MINE/none dsh-hc install-template >/dev/null
check "install-template keeps a dsh template the person wrote" "$(grep -c '^command: my-dsh$' "$MINE/herdr-core/templates/dsh.md")" 1
rm -rf "$MINE"

for t in "$T" "$A" "$B" "$Q" "$E" "$V" "$S" "$R" "$F"; do hc kill "$t" >/dev/null 2>&1; hc rm "$t" >/dev/null 2>&1; done
for t in $(dsh_terminals); do hc kill "$t" >/dev/null 2>&1; done
[ $FAILED = 0 ] && echo "all passed" || echo "some checks failed"
exit $FAILED
