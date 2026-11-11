# Minimal Anthropic-Messages-compatible SSE mock for DSH tests.
# Usage: python3 -I mock-llm.py <port> [request-log]   then run dsh with
#   DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/v1 DEEPSEEK_API_KEY=mock-key
# The latest user prompt steers the reply:
#   [[slow]]  answer after 4 s (time to observe `working` or interrupt); [[slow:N]] after N s
#   [[fail]]  answer HTTP 400 (a non-retryable model error)
#   [[approve]]  call bash on a path outside the workspace; after the sandbox denial, retry it
#             with sandbox_permissions, which raises an approval request
#   [[question]]  call ask_user_question (pick red or blue), then echo the tool result
#   [[env]]   run `echo DSH_HC_TERMINAL=$DSH_HC_TERMINAL` in bash, then echo the tool result
#   [[hc:NAME]]  in bash, `hc send NAME` a greeting and start a helper NAME-kid, then echo the result
#   [[stream]]  stream the reply word by word, 0.15 s apart
# The request log records whether the herdr-bridge skill is in the model's context.
#   anything else: answer "MOCK-REPLY: <prompt>" at once
# Prompts listed in DEMOS play a scripted English scene for the README media (demo-media.py).
import json, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open(sys.argv[2] if len(sys.argv) > 2 else "/dev/null", "a")


CONTEXT_PREFIXES = ("Current runtime context", "<system-reminder>", "Time sampled")


def latest_prompt(body):
    # DSH merges consecutive user inputs (e.g. a cancelled prompt and the next one) and appends
    # runtime-context parts, so take the last text part that is not injected context.
    for message in reversed(body.get("messages", [])):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        texts = [p["text"] for p in content or [] if p.get("type") == "text" and not p["text"].startswith(CONTEXT_PREFIXES)]
        if texts:
            return texts[-1]
    return ""


APPROVAL_COMMAND = "touch /var/tmp/dsh-bridge-approval-probe"


def pending_tool_use(body):
    """The assistant tool call answered by the latest user message, if it carries a tool result."""
    messages = body.get("messages", [])
    if not messages or messages[-1].get("role") != "user":
        return None
    content = messages[-1].get("content")
    if not isinstance(content, list) or not any(p.get("type") == "tool_result" for p in content):
        return None
    for message in reversed(messages[:-1]):
        if message.get("role") == "assistant":
            return next((p for p in message.get("content") or [] if p.get("type") == "tool_use"), None)
    return None


def tool_result_text(body):
    content = body["messages"][-1].get("content") or []
    for part in content:
        if part.get("type") == "tool_result":
            inner = part.get("content")
            if isinstance(inner, str):
                return inner
            return " ".join(p.get("text", "") for p in inner or [] if isinstance(p, dict))
    return ""


# README demo scripts (scripts/demo-media.sh), keyed by the exact prompt so screenshots show no
# markers. Each step is the reply to one model call within the turn: optional text, then optional
# bash call; `wait` holds the reply that many seconds first (keeps the session `working`).
DEMO_RELEASE_COMMAND = "mkdir -p /var/tmp/acme-releases/1.4.0 && cp -R dist/. /var/tmp/acme-releases/1.4.0/"
DEMOS = {
    "The date parsing test is failing. Find out why and fix it.": {
        "title": "Fix failing date parsing test",
        "steps": [
            {"text": "I'll run the test suite to see the failure.", "wait": 3,
             "bash": {"command": "python3 -m unittest 2>&1 | tail -1", "description": "Run the unit tests"}},
            {"wait": 5, "text": "`parse_date` uses a fixed format, so ISO timestamps ending in `Z` are rejected. "
                     "I'll strip the UTC suffix before parsing.",
             "bash": {"command": "sed -i.bak 's/strptime(value,/strptime(value.removesuffix(\"Z\"),/' acme/dates.py && rm acme/dates.py.bak",
                      "description": "Accept a trailing Z in parse_date"}},
            {"wait": 3, "bash": {"command": "python3 -m unittest 2>&1 | tail -1", "description": "Run the unit tests again"}},
            {"wait": 2, "text": "Fixed. `parse_date` now accepts UTC timestamps like `2026-03-01T09:30:00Z`, "
                     "and all 6 tests pass."},
        ],
    },
    "Review the uncommitted changes in billing/ and list anything risky.": {
        "title": "Review billing changes",
        "steps": [
            {"text": "Let me look at what changed.",
             "bash": {"command": "git diff --stat -- billing/", "description": "Summarize the billing diff"}},
            {"text": "Reading through `billing/invoice.py`: the rounding change moves from per-line to per-invoice totals, "
                     "which can shift amounts by a cent on multi-line invoices. ", "wait": 900},
            {"text": "Done."},
        ],
    },
    "Copy the 1.4.0 build to the shared release folder /var/tmp/acme-releases.": {
        "title": "Publish 1.4.0 build",
        "steps": [
            {"text": "Copying the build into the release folder.",
             "bash": {"command": DEMO_RELEASE_COMMAND, "description": "Copy the build to the release folder"}},
            {"text": "The sandbox blocks writes outside the workspace, so I'll ask for permission.",
             "bash": {"command": DEMO_RELEASE_COMMAND, "description": "Copy the build to the release folder",
                      "sandbox_permissions": "danger-full-access",
                      "justification": "The shared release folder is outside the workspace."}},
            {"text": "Copied the 1.4.0 build to `/var/tmp/acme-releases/1.4.0`."},
        ],
    },
}


def demo_for(body):
    """The demo script and the step this call answers, if the turn started with a demo prompt."""
    messages = body.get("messages", [])
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if m.get("role") != "user":
            continue
        content = m.get("content")
        texts = [content] if isinstance(content, str) else [p.get("text", "") for p in content or [] if p.get("type") == "text"]
        demo = next((DEMOS[t.strip()] for t in texts if t.strip() in DEMOS), None)
        if demo:
            calls = sum(1 for a in messages[i + 1:] if a.get("role") == "assistant"
                        for p in a.get("content") or [] if isinstance(p, dict) and p.get("type") == "tool_use")
            return demo, min(calls, len(demo["steps"]) - 1)
    return None, 0


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}"
        body = json.loads(raw)
        prompt = latest_prompt(body)
        title = prompt.startswith("Generate the session title")
        LOG.write(json.dumps({"path": self.path, "prompt": prompt[:200], "bridge_skill": b"herdr-bridge" in raw}) + "\n")
        LOG.flush()
        if not title and "[[fail]]" in prompt:
            self.send_response(400)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": "mock failure: " + "the gateway rejected this request; " * 8 + "\nsecond line of the error, end-of-error"}}).encode())
            return
        slow = re.search(r"\[\[slow(?::(\d+))?\]\]", prompt)
        if not title and slow:
            time.sleep(int(slow.group(1) or 4))
        text = "Mock title" if title else f"MOCK-REPLY: {prompt[:80]}"
        if title:
            text = next((d["title"] for k, d in DEMOS.items() if k.encode() in raw), text)
        demo, step = (None, 0) if title else demo_for(body)
        if demo:
            step = demo["steps"][step]
            time.sleep(step.get("wait", 0))
            blocks = ([("text", step["text"])] if "text" in step else []) + ([("tool_use", ("bash", step["bash"]))] if "bash" in step else [])
            return self.reply(blocks, pace=0.04)
        tool_input, tool_name = None, "bash"
        if not title and "[[approve]]" in prompt:
            answered = pending_tool_use(body)
            if answered is None:
                tool_input = {"command": APPROVAL_COMMAND, "description": "approval probe"}
            elif "sandbox_permissions" not in (answered.get("input") or {}):
                tool_input = {"command": APPROVAL_COMMAND, "description": "approval probe", "sandbox_permissions": "danger-full-access", "justification": "bridge approval test"}
            else:
                text = "MOCK-REPLY: approval flow finished"
        if not title and "[[env]]" in prompt:
            if pending_tool_use(body) is None:
                tool_input = {"command": "echo DSH_HC_TERMINAL=$DSH_HC_TERMINAL", "description": "show hc address"}
            else:
                text = f"MOCK-REPLY: env says {tool_result_text(body)[:200]}"
        hc_to = re.search(r"\[\[hc:([a-z0-9-]+)\]\]", prompt)
        if not title and hc_to:
            if pending_tool_use(body) is None:
                name = hc_to.group(1)
                tool_input = {"command": f"hc send {name} 'hi from dsh' >/dev/null && hc run --bg --name {name}-kid sleep 60 >/dev/null && echo sent",
                              "description": "talk to hc"}
            else:
                text = f"MOCK-REPLY: hc says {tool_result_text(body)[:200]}"
        if not title and "[[question]]" in prompt:
            if pending_tool_use(body) is None:
                tool_name = "ask_user_question"
                tool_input = {"questions": [{"id": "color", "header": "Color", "question": "Pick a color",
                                             "options": [{"label": "red"}, {"label": "blue"}]}]}
            else:
                text = f"MOCK-REPLY: answer was {tool_result_text(body)[:200]}"
        pace = 0.15 if "[[stream]]" in prompt else 0.0
        self.reply([("text", text)] if tool_input is None else [("tool_use", (tool_name, tool_input))], pace)

    def reply(self, blocks, pace=0.0):
        """Stream content blocks (("text", str) or ("tool_use", (name, input))); text in word chunks `pace` s apart."""
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()

        def ev(name, data):
            self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()

        ev("message_start", {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "model": "mock", "content": [], "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 0}}})
        for index, (kind, value) in enumerate(blocks):
            if kind == "text":
                ev("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}})
                for chunk in re.findall(r"\S+\s*", value) if pace else [value]:
                    ev("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": chunk}})
                    time.sleep(pace)
            else:
                name, tool_input = value
                ev("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": f"toolu_{time.time_ns()}", "name": name, "input": {}}})
                ev("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": json.dumps(tool_input)}})
            ev("content_block_stop", {"type": "content_block_stop", "index": index})
        stop = "tool_use" if any(kind == "tool_use" for kind, _ in blocks) else "end_turn"
        ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 2}})
        ev("message_stop", {"type": "message_stop"})

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
