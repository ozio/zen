#!/usr/bin/env python3
"""Exercise a real stdio subprocess; optionally inspect the live playground."""

import argparse
import base64
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading


class Session:
    def __init__(self, repo):
        server = Path(__file__).with_name("server.py")
        self.process = subprocess.Popen([sys.executable, str(server), "serve", "--repo", str(repo)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.responses = queue.Queue()
        self.errors = bytearray()
        self.number = 0
        self.closed = False
        self.readers = []
        for stream, handler in ((self.process.stdout, lambda line:self.responses.put(line)), (self.process.stderr, lambda line:self.errors.extend(line))):
            def read(source=stream, receive=handler):
                for line in iter(source.readline, b""):
                    receive(line)
                if source is self.process.stdout:
                    self.responses.put(None)
            thread = threading.Thread(target=read, daemon=True)
            thread.start()
            self.readers.append(thread)

    def send(self, payload):
        self.process.stdin.write(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
        self.process.stdin.flush()

    def request(self, method, params=None):
        self.number += 1
        self.send({"jsonrpc":"2.0","id":self.number,"method":method,"params":params or {}})
        try:
            raw = self.responses.get(timeout=45)
        except queue.Empty as exc:
            raise RuntimeError("MCP stdio response timeout") from exc
        if raw is None:
            raise RuntimeError("MCP server closed stdout before responding")
        value = json.loads(raw.decode("utf-8"))
        if value.get("id") != self.number or value.get("jsonrpc") != "2.0":
            raise RuntimeError("MCP response ID/type mismatch or stdout noise")
        return value

    def initialize(self):
        response = self.request("initialize", {"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"zen-protocol-check","version":"1.0"}})
        if response.get("result", {}).get("protocolVersion") != "2025-06-18":
            raise RuntimeError("MCP initialization failed")
        self.send({"jsonrpc":"2.0","method":"notifications/initialized"})
        return self.request("tools/list")["result"]["tools"]

    def tool(self, name, arguments=None):
        response = self.request("tools/call", {"name":name,"arguments":arguments or {}})
        if "error" in response:
            raise RuntimeError("MCP tool dispatch failed: " + response["error"]["message"])
        return response["result"]

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        for reader in self.readers:
            reader.join(timeout=2)
        self.process.stdout.close()
        self.process.stderr.close()
        if self.process.returncode != 0:
            raise RuntimeError("MCP server exited unsuccessfully")
        while not self.responses.empty():
            if self.responses.get_nowait() is not None:
                raise RuntimeError("Unexpected stdout after final MCP response")


def content(result):
    if result.get("isError"):
        raise RuntimeError(result["content"][0]["text"])
    return json.loads(result["content"][0]["text"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--screenshot", type=Path, help="Save live native chrome PNG to this path")
    options = parser.parse_args(argv)
    if options.screenshot and not options.live:
        parser.error("--screenshot requires --live")
    session = Session(options.repo)
    try:
        tools = session.initialize()
        names = {tool["name"] for tool in tools}
        expected = {"playground_state","playground_inspect","playground_click","playground_input","playground_tabs","playground_spaces","playground_screenshot"}
        if names != expected:
            raise RuntimeError("Unexpected MCP tool inventory")
        invalid = session.request("tools/call", {"name":"missing-tool","arguments":{}})
        if invalid.get("error", {}).get("code") != -32602:
            raise RuntimeError("Unknown MCP tool did not fail")
        if options.live:
            state = content(session.tool("playground_state"))
            snapshot = content(session.tool("playground_inspect"))
            shot = session.tool("playground_screenshot")
            if shot.get("isError") or shot["content"][0].get("type") != "image":
                raise RuntimeError("Chrome screenshot failed")
            raw = base64.b64decode(shot["content"][0]["data"], validate=True)
            if not raw.startswith(b"\x89PNG\r\n\x1a\n") or not snapshot["elements"]:
                raise RuntimeError("Live chrome inspection or screenshot has no evidence")
            if ("[ZEN PLAYGROUND]" not in state["browser"].get("title", "")
                    or any("[ZEN PLAYGROUND]" not in win.get("title", "") for win in state["browser"].get("windows", []))):
                raise RuntimeError("Persistent playground marker is missing from an actual native window title")
            if options.screenshot:
                options.screenshot.write_bytes(raw)
            print(json.dumps({"identity":state["identity"],"native_elements":len(snapshot["elements"]),"tabs":len(state["browser"]["tabs"]),"spaces":state["browser"]["spaces"],"screenshot_bytes":len(raw)}, ensure_ascii=False, indent=2))
        else:
            # Default protocol check must be safe while a real browser is running.
            # A non-existing repo-side state always refuses before connecting.
            import tempfile
            with tempfile.TemporaryDirectory(prefix="zen-protocol-refusal-") as temp:
                refusal_session = Session(Path(temp).resolve())
                try:
                    refusal_session.initialize()
                    refusal = refusal_session.tool("playground_state")
                    if not refusal.get("isError"):
                        raise RuntimeError("Missing playground state did not refuse")
                finally:
                    refusal_session.close()
        session.close()
        session = None
        print("MCP LIVE VERIFIED" if options.live else "MCP PROTOCOL VERIFIED")
        return 0
    except Exception as exc:
        print("Protocol check failed: " + str(exc), file=sys.stderr)
        return 1
    finally:
        if session:
            try:
                session.close()
            except Exception as exc:
                print("Protocol server cleanup failed: " + str(exc), file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
