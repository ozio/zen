#!/usr/bin/env python3
"""MCP stdio entrypoint and read-only live inspection commands."""

import argparse
import json
from pathlib import Path
import sys

try:
    from .bridge import Bridge, DEFAULT_SELECTOR
    from .identity import Refusal, no_duplicates
    from .marionette import ProtocolError, RemoteError
except ImportError:
    from bridge import Bridge, DEFAULT_SELECTOR
    from identity import Refusal, no_duplicates
    from marionette import ProtocolError, RemoteError

MAX_LINE = 1024 * 1024
VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")


def schema(properties=None, required=None):
    return {"type":"object", "properties":properties or {}, "required":required or [], "additionalProperties":False}


STRING = {"type":"string"}
SNAPSHOT_FIELDS = {"snapshot_id":STRING, "handle":STRING}
TOOLS = [
    {"name":"playground_state", "description":"Verify the exact isolated Zen process and read browser chrome windows, tabs and Spaces.", "inputSchema":schema(), "annotations":{"readOnlyHint":True}},
    {"name":"playground_inspect", "description":"Inspect actual browser chrome DOM. Returns native handles valid for 30 seconds and one action. Refresh before every action; values of inputs are omitted.", "inputSchema":schema({"selector":{"type":"string","default":DEFAULT_SELECTOR}, "include_hidden":{"type":"boolean","default":False}, "limit":{"type":"integer","minimum":1,"maximum":2000,"default":300}}), "annotations":{"readOnlyHint":True}},
    {"name":"playground_click", "description":"Native WebDriver click on a handle from the latest chrome inspection. Consumes that snapshot.", "inputSchema":schema(SNAPSHOT_FIELDS, ["snapshot_id","handle"]), "annotations":{"readOnlyHint":False,"destructiveHint":False}},
    {"name":"playground_input", "description":"Native WebDriver text input (including WebDriver key characters), optionally clear first. Consumes snapshot; does not echo the supplied text.", "inputSchema":schema(dict(SNAPSHOT_FIELDS, text=STRING, clear={"type":"boolean","default":True}), ["snapshot_id","handle","text"]), "annotations":{"readOnlyHint":False,"destructiveHint":False}},
    {"name":"playground_tabs", "description":"Open an HTTP(S)/about:blank tab, or select/close a native tab handle from the latest snapshot. Refuses closing the final tab.", "inputSchema":schema(dict(SNAPSHOT_FIELDS, action={"type":"string","enum":["open","select","close"]}, url=STRING), ["action"]), "annotations":{"readOnlyHint":False,"destructiveHint":False}},
    {"name":"playground_spaces", "description":"Select an existing Zen Space listed in the latest snapshot. Checks API availability and reads back the active Space.", "inputSchema":schema({"snapshot_id":STRING,"space_id":STRING}, ["snapshot_id","space_id"]), "annotations":{"readOnlyHint":False,"destructiveHint":False}},
    {"name":"playground_screenshot", "description":"Capture a PNG viewport screenshot of actual browser chrome, including native sidebar and toolbars.", "inputSchema":schema(), "annotations":{"readOnlyHint":True}},
]


class RequestError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def validate_arguments(tool, arguments):
    definition = tool["inputSchema"]
    if not isinstance(arguments, dict) or set(arguments) - set(definition["properties"]) or set(definition["required"]) - set(arguments):
        raise RequestError(-32602, "Missing or unknown tool arguments")
    for key, value in arguments.items():
        prop = definition["properties"][key]
        valid = ((prop["type"] == "string" and isinstance(value, str))
                 or (prop["type"] == "boolean" and type(value) is bool)
                 or (prop["type"] == "integer" and type(value) is int))
        if not valid or ("enum" in prop and value not in prop["enum"]) or ("minimum" in prop and value < prop["minimum"]) or ("maximum" in prop and value > prop["maximum"]):
            raise RequestError(-32602, "Invalid type or value for argument " + key)
    if tool["name"] == "playground_tabs" and arguments["action"] in ("select", "close") and not {"snapshot_id","handle"}.issubset(arguments):
        raise RequestError(-32602, "Selecting or closing a tab requires snapshot_id and handle")
    if tool["name"] == "playground_tabs":
        forbidden = {"snapshot_id", "handle"} if arguments["action"] == "open" else {"url"}
        if forbidden.intersection(arguments):
            raise RequestError(-32602, "Arguments do not apply to this tab action")


def text_content(value):
    return {"content":[{"type":"text", "text":json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)}]}


class MCPServer:
    def __init__(self, bridge):
        self.bridge = bridge
        self.initialized = False
        self.ready = False

    def call(self, name, arguments):
        definition = next((tool for tool in TOOLS if tool["name"] == name), None)
        if definition is None:
            raise RequestError(-32602, "Unknown tool")
        validate_arguments(definition, arguments)
        try:
            if name == "playground_screenshot":
                return {"content":[{"type":"image","data":self.bridge.screenshot(),"mimeType":"image/png"}]}
            method = {"playground_state":"state","playground_inspect":"inspect","playground_click":"click",
                      "playground_input":"input","playground_tabs":"tab","playground_spaces":"space"}[name]
            return text_content(getattr(self.bridge, method)(**arguments))
        except (Refusal, ProtocolError, RemoteError, OSError, ValueError) as exc:
            # Diagnostics never include tool arguments, credentials or remote stack traces.
            print("zen-playground: %s" % type(exc).__name__, file=sys.stderr, flush=True)
            message = exc.code if isinstance(exc, RemoteError) else str(exc)
            return {"content":[{"type":"text","text":message}], "isError":True}

    def dispatch(self, request):
        request_id = request.get("id") if isinstance(request, dict) else None
        notification = isinstance(request, dict) and "id" not in request
        try:
            if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
                raise RequestError(-32600, "Invalid JSON-RPC request")
            if not notification and (type(request_id) not in (str, int) or request_id is None):
                request_id = None
                raise RequestError(-32600, "Request ID must be a string or integer")
            method = request["method"]
            params = request.get("params", {})
            if not isinstance(params, dict):
                raise RequestError(-32602, "Parameters must be an object")
            if notification:
                if method == "notifications/initialized" and self.initialized:
                    self.ready = True
                return None
            if method == "initialize":
                if self.initialized:
                    raise RequestError(-32600, "Already initialized")
                if not isinstance(params.get("protocolVersion"), str) or not isinstance(params.get("clientInfo"), dict) or not isinstance(params.get("capabilities"), dict):
                    raise RequestError(-32602, "Invalid initialization parameters")
                self.initialized = True
                result = {"protocolVersion":params["protocolVersion"] if params["protocolVersion"] in VERSIONS else "2025-06-18",
                          "capabilities":{"tools":{"listChanged":False}},
                          "serverInfo":{"name":"zen-playground","version":"1.0.0"},
                          "instructions":"Controls only the identified local Zen Playground. Inspect fresh chrome before every UI action. Does not provide page content or arbitrary evaluation."}
            elif method == "ping":
                result = {}
            elif not self.ready:
                raise RequestError(-32002, "Initialize and send notifications/initialized first")
            elif method == "tools/list":
                result = {"tools":TOOLS}
            elif method == "tools/call":
                if not isinstance(params.get("name"), str):
                    raise RequestError(-32602, "Missing tool name")
                result = self.call(params["name"], params.get("arguments", {}))
            else:
                raise RequestError(-32601, "Method not found")
            return {"jsonrpc":"2.0","id":request_id,"result":result}
        except RequestError as exc:
            if notification:
                return None
            return {"jsonrpc":"2.0","id":request_id,"error":{"code":exc.code,"message":str(exc)}}
        except Exception:
            print("zen-playground: internal error", file=sys.stderr, flush=True)
            if notification:
                return None
            return {"jsonrpc":"2.0","id":request_id,"error":{"code":-32603,"message":"Internal error"}}

    def serve(self, incoming, outgoing):
        try:
            while True:
                line = incoming.readline(MAX_LINE + 1)
                if not line:
                    break
                try:
                    if len(line) > MAX_LINE:
                        while line and not line.endswith(b"\n"):
                            line = incoming.readline(MAX_LINE + 1)
                        raise ValueError("Request exceeds size limit")
                    request = json.loads(line.decode("utf-8"), object_pairs_hook=no_duplicates, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
                    response = self.dispatch(request)
                except (UnicodeError, ValueError, Refusal, RecursionError):
                    response = {"jsonrpc":"2.0","id":None,"error":{"code":-32700,"message":"Invalid JSON request"}}
                if response is not None:
                    outgoing.write(json.dumps(response, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n")
                    outgoing.flush()
        finally:
            try:
                self.bridge.close()
            except Exception:
                print("zen-playground: disconnect failed", file=sys.stderr, flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("serve","check-live","inspect"), default="serve")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--selector", default=DEFAULT_SELECTOR)
    parser.add_argument("--limit", type=int, default=300)
    options = parser.parse_args(argv)
    bridge = None
    try:
        bridge = Bridge(options.repo)
        if options.command == "serve":
            MCPServer(bridge).serve(sys.stdin.buffer, sys.stdout.buffer)
        else:
            result = bridge.state() if options.command == "check-live" else bridge.inspect(options.selector, limit=options.limit)
            print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    except (Refusal, ProtocolError, RemoteError, OSError, ValueError) as exc:
        print("zen-playground: " + str(exc), file=sys.stderr)
        return 1
    finally:
        if bridge:
            try:
                bridge.close()
            except Exception:
                print("zen-playground: disconnect failed", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
