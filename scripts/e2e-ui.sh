#!/bin/sh
# UI-side end-to-end checks: a browser (ego-browser) plays the person in DSH Desktop against the
# isolated `dsh web`, and hc plays the Herdr agent. Run scripts/dev.sh up first.
# Covers: Desktop-origin sessions mirrored on first run (nothing streamed before the mirror joins is lost), /herdr, approvals and questions answered
# from either side (the other side's prompt is withdrawn), and a Herdr agent taking a session over.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
eval "$("$ROOT/scripts/dev.sh" env)"
ISO=${DSH_BRIDGE_ISO:-/tmp/dsh-iso}
URL=$(grep -o 'http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$ISO/web.log" | tail -1)
[ -n "$URL" ] || { echo "no dsh web URL in $ISO/web.log; run scripts/dev.sh up"; exit 1; }
FAILED=0

# ego-browser prints console output on stderr; results are the lines marked RESULT:.
result() { sed -n 's/^RESULT://p' | tail -1; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; FAILED=1; fi; }
state() { hc get "$1" --json 2>/dev/null | python3 -I -c 'import json,sys;s=json.load(sys.stdin).get("status") or {};print(s.get("state",""))'; }
turn() { hc get "$1" --json | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["turn"])'; }
seen() { hc get "$1" --json | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("labels",{}).get("herdr.seen",""))'; }
dsh_names() { hc ls --json | python3 -I -c 'import json,sys;[print(t.get("name") or "") for t in json.load(sys.stdin)["terminals"] if t.get("agent")=="dsh"]' | sort; }

# ui <javascript>: run in the browser task space with `page`, `send(text)`, and `text()` defined.
ui() {
  ego-browser nodejs <<EOF
const task = await taskSpace("dsh-herdr-bridge UI tests");
const COMPOSER = "loc=role:textbox[name*='commands, @ files']";
const page = task.page("p1");
if (!(await page.url()).startsWith("${URL%%\?*}")) {
  await page.goto("$URL", { timeout: 30000 });
  await page.waitForSelector(COMPOSER, { timeout: 30000 });
}
const notice = await page.evaluate(() => [...document.querySelectorAll("button")].some(b => b.innerText.trim() === "Continue"));
if (notice) await page.click("loc=role:button[name='Continue']", { label: "dismiss notice" });
const text = () => page.evaluate(() => document.body.innerText);
async function send(t) {
  await page.click(COMPOSER, { label: "focus composer" });
  await page.keyboard.type(t);
  await page.click("loc=css:button[aria-label=\"Send message\"]", { label: "send" });
}
$1
EOF
}

# 1. A session started in Desktop is mirrored on its first run as dsh-<short id>.
BEFORE=$(dsh_names)
ui '
await page.keyboard.press("Alt+Meta+n");
await page.waitForTimeout(1000);
await send("started in the UI [[e2e]]");
await page.waitForFunction(() => document.body.innerText.includes("MOCK-REPLY: started in the UI"), undefined, { timeout: 30000 });
' >/dev/null
sleep 1
printf '%s\n' "$BEFORE" > "$ISO/names.before"
NEW=$(dsh_names | grep -vxF -f "$ISO/names.before" | head -1)
check "a Desktop session is mirrored as dsh-<short id>" "$(printf %s "$NEW" | cut -c1-4)" dsh-
check "and reports its finished turn" "$(state "$NEW")" done
SPACE=$(hc get "$NEW" --json | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("labels",{}).get("herdr.space",""))')
check "and is placed in a Herdr App space by folder" "$(printf %s "$SPACE" | cut -c1-4)" dsh-

# 2. /herdr prints the session's hc address.
OUT=$(ui '
await page.click(COMPOSER, { label: "focus composer" });
await page.keyboard.type("/herdr");
await page.waitForTimeout(600);
await page.keyboard.press("Enter");
await page.waitForTimeout(600);
if ((await page.evaluate(() => document.querySelector("[role=textbox]")?.innerText ?? "")).includes("/herdr")) await page.keyboard.press("Enter");
await page.waitForFunction(() => document.body.innerText.includes("In Herdr as"), undefined, { timeout: 15000 });
console.log("RESULT:" + (await text()).split("\n").filter(l => l.includes("In Herdr as")).pop());
' 2>&1 | result)
case "$OUT" in *"($NEW)"*) check "/herdr prints the hc address" yes yes ;; *) check "/herdr prints the hc address" "$OUT" "…($NEW)…" ;; esac

# 3. An approval raised in Desktop, answered from hc: the Desktop dialog is withdrawn.
rm -f /var/tmp/dsh-bridge-approval-probe
ui '
await send("approval answered from hc [[approve]]");
await page.waitForSelector("loc=role:button[name=\"Allow once\"]", { timeout: 30000 });
' >/dev/null
check "Desktop approval shows as blocked in hc" "$(state "$NEW")" blocked
hc send --force --wait --timeout 60 "$NEW" y >/dev/null
GONE=$(ui '
await page.waitForFunction(() => document.body.innerText.includes("approval flow finished"), undefined, { timeout: 30000 });
console.log("RESULT:" + await page.evaluate(() => ![...document.querySelectorAll("button")].some(b => /^(Allow once|Reject)$/.test(b.innerText.trim()))));
' 2>&1 | result)
check "answering in hc withdraws the Desktop dialog" "$GONE" true
check "and the approved command ran" "$([ -e /var/tmp/dsh-bridge-approval-probe ] && echo ran)" ran
rm -f /var/tmp/dsh-bridge-approval-probe

# 4. The same, answered in Desktop: hc sees it settle.
ui '
await send("approval answered in Desktop [[approve]]");
await page.waitForSelector("loc=role:button[name=\"Reject\"]", { timeout: 30000 });
await page.click("loc=role:button[name=\"Reject\"]", { label: "reject in Desktop" });
' >/dev/null
hc wait "$NEW" --timeout 60 >/dev/null
if hc read "$NEW" --lines 30 | grep -q "answered in DSH Desktop"; then check "answering in Desktop settles the hc prompt" yes yes; else check "answering in Desktop settles the hc prompt" no yes; fi
check "and the rejected command did not run" "$([ -e /var/tmp/dsh-bridge-approval-probe ] && echo ran || echo no)" no

# 5. A question raised in Desktop, answered from hc: the Desktop question is withdrawn.
ui '
await send("question answered from hc [[question]]");
await page.waitForFunction(() => document.body.innerText.includes("Pick a color"), undefined, { timeout: 30000 });
' >/dev/null
check "Desktop question shows as blocked in hc" "$(state "$NEW")" blocked
hc send --force --wait --timeout 60 "$NEW" 2 >/dev/null
GONE=$(ui '
await page.waitForFunction(() => document.body.innerText.includes("answer was"), undefined, { timeout: 30000 });
console.log("RESULT:" + await page.evaluate(() => ![...document.querySelectorAll("button,[role=radio],[role=option]")].some(e => /^(red|blue)$/i.test(e.innerText.trim()) && e.offsetParent !== null)));
' 2>&1 | result)
check "answering in hc withdraws the Desktop question" "$GONE" true

# 6. A Herdr agent takes the session over: the automatic mirror makes way.
SHORT=$(printf %s "$NEW" | sed 's/^dsh-//')
hc run --bg --name "ui-taker-$SHORT" dsh-hc attach "$SHORT" >/dev/null; sleep 2
check "takeover closes the automatic mirror" "$(hc get "$NEW" --json >/dev/null 2>&1 && echo still-there || echo gone)" gone
check "and the taker reports the session" "$(state "ui-taker-$SHORT")" done
hc kill "ui-taker-$SHORT" >/dev/null 2>&1; hc rm "ui-taker-$SHORT" >/dev/null 2>&1

# 7. A reply already streaming when the mirror opens arrives whole (nothing lost before it joined).
printf '%s\n' "$(dsh_names)" > "$ISO/names.before"
ui '
await page.keyboard.press("Alt+Meta+n");
await page.waitForTimeout(1000);
await send("a reply that streams word by word while its mirror opens [[stream]]");
await page.waitForFunction(() => document.body.innerText.includes("while its mirror opens"), undefined, { timeout: 30000 });
' >/dev/null
sleep 1
STREAMED=$(dsh_names | grep -vxF -f "$ISO/names.before" | head -1)
hc wait "$STREAMED" --timeout 60 >/dev/null
if hc read "$STREAMED" --lines 40 | grep -qF "MOCK-REPLY: a reply that streams word by word while its mirror opens"; then check "a reply streaming before the mirror joined arrives whole" yes yes; else check "a reply streaming before the mirror joined arrives whole" no yes; fi

# 8. A Desktop session that fails on its first run counts a turn in hc; failing in front of the
#    person, it is seen at once but stays error. Archiving it in Desktop closes its terminal.
printf '%s\n' "$(dsh_names)" > "$ISO/names.before"
ui '
await page.keyboard.press("Alt+Meta+n");
await page.waitForTimeout(1000);
await send("fails on its first run [[fail]]");
await page.waitForFunction(() => document.body.innerText.includes("mock failure"), undefined, { timeout: 30000 });
' >/dev/null
sleep 2
FAILING=$(dsh_names | grep -vxF -f "$ISO/names.before" | head -1)
check "a first run that fails in view counts a turn and is seen at once" "$(state "$FAILING"):$(turn "$FAILING"):$(seen "$FAILING")" error:1:1
ui '
await page.hover("loc=css:[role=treeitem][aria-selected=true]", { label: "show session actions" });
await page.click("loc=css:[role=treeitem][aria-selected=true] button[aria-label=\"Archive session\"]", { label: "archive session" });
' >/dev/null
sleep 2
check "archiving the session in Desktop closes its terminal" "$(hc get "$FAILING" --json >/dev/null 2>&1 && echo still-there || echo gone)" gone

# 9. Looking at a session in the DSH window marks its hc terminal seen (herdr.seen), as a Herdr
#    client would: a seen error stays error; a turn that ends in view is seen; one out of view isn't.
# A session started from hc can take a moment to reach the sidebar: wait for its row. Its folder's
# group may be collapsed (DSH 0.2.2-rc.2 keeps only some groups open), so expand them first.
open_session() {
  ROW="[data-row-key=\"session:$(hc get "$1" --json | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["labels"]["dsh.session"])')\"]"
  ui "await page.evaluate(() => document.querySelectorAll('[data-row-key^=\"workspace:\"][aria-expanded=\"false\"]').forEach(e => e.click())); await page.waitForSelector('loc=css:$ROW', { timeout: 10000 }); await page.click('loc=css:$ROW', { label: 'open session' }); await page.waitForTimeout(1500);" >/dev/null
}
ERR=ui-err-$$; OK=ui-ok-$$
hc run --bg --name "$ERR" dsh "fails out of view [[fail]]" >/dev/null; hc wait "$ERR" --timeout 60 >/dev/null
hc run --bg --name "$OK" dsh "finishes out of view [[e2e]]" >/dev/null; hc wait "$OK" --timeout 60 >/dev/null
check "an error out of view stays error, not seen" "$(state "$ERR"):$(seen "$ERR")" error:
open_session "$ERR"
check "opening it in the DSH window marks it seen and it stays error" "$(state "$ERR"):$(seen "$ERR")" error:$(turn "$ERR")
hc send --wait --timeout 60 "$ERR" "again in view [[e2e]]" >/dev/null; sleep 1
check "a turn that ends in view is seen" "$(turn "$ERR"):$(seen "$ERR")" 2:2
check "a turn that ended out of view is not" "$(state "$OK"):$(seen "$OK")" done:
open_session "$OK"
check "until its session is opened" "$(seen "$OK")" 1
for t in "$ERR" "$OK"; do hc kill "$t" >/dev/null 2>&1; hc rm "$t" >/dev/null 2>&1; done

[ $FAILED = 0 ] && echo "all passed" || echo "some checks failed"
exit $FAILED
