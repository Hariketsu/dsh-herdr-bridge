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
# The request log records whether the herdr-bridge skill is in the model's context.
#   anything else: answer "MOCK-REPLY: <prompt>" at once
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
            self.wfile.write(json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": "mock failure"}}).encode())
            return
        slow = re.search(r"\[\[slow(?::(\d+))?\]\]", prompt)
        if not title and slow:
            time.sleep(int(slow.group(1) or 4))
        text = "Mock title" if title else f"MOCK-REPLY: {prompt[:80]}"
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
        if not title and "[[question]]" in prompt:
            if pending_tool_use(body) is None:
                tool_name = "ask_user_question"
                tool_input = {"questions": [{"id": "color", "header": "Color", "question": "Pick a color",
                                             "options": [{"label": "red"}, {"label": "blue"}]}]}
            else:
                text = f"MOCK-REPLY: answer was {tool_result_text(body)[:200]}"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()

        def ev(name, data):
            self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()

        ev("message_start", {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "model": "mock", "content": [], "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 0}}})
        if tool_input is None:
            ev("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
            ev("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}})
            stop = "end_turn"
        else:
            ev("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": f"toolu_{time.time_ns()}", "name": tool_name, "input": {}}})
            ev("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(tool_input)}})
            stop = "tool_use"
        ev("content_block_stop", {"type": "content_block_stop", "index": 0})
        ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 2}})
        ev("message_stop", {"type": "message_stop"})


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
