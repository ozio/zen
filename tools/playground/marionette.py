"""Minimal synchronous Marionette v3 client; no browser lifecycle operations."""

import json
import socket

MAX_PACKET = 32 * 1024 * 1024
ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf"


class ProtocolError(RuntimeError):
    pass


class RemoteError(RuntimeError):
    def __init__(self, error):
        self.code = error.get("error", "unknown error")
        super().__init__("%s: %s" % (self.code, error.get("message", "")))


def encode_packet(value):
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(body) > MAX_PACKET:
        raise ProtocolError("Marionette packet exceeds size limit")
    return str(len(body)).encode("ascii") + b":" + body


class Marionette:
    def __init__(self, host="127.0.0.1", port=2828, timeout=15):
        if host != "127.0.0.1":
            raise ProtocolError("Only IPv4 loopback is permitted")
        self.host, self.port, self.timeout = host, port, timeout
        self.sock = None
        self.sequence = 0
        self.session_id = None

    def connect(self):
        self.sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock.settimeout(self.timeout)
        try:
            hello = self.receive()
            if not isinstance(hello, dict) or hello.get("marionetteProtocol") != 3 or hello.get("applicationType") != "gecko":
                raise ProtocolError("Unsupported Marionette greeting (requires Gecko protocol 3)")
            return hello
        except Exception:
            self.close()
            raise

    def _exact(self, count):
        chunks = []
        while count:
            chunk = self.sock.recv(min(count, 65536))
            if not chunk:
                raise ProtocolError("Marionette closed a partial frame")
            chunks.append(chunk)
            count -= len(chunk)
        return b"".join(chunks)

    def receive(self):
        prefix = bytearray()
        while True:
            byte = self._exact(1)
            if byte == b":":
                break
            if not b"0" <= byte <= b"9" or len(prefix) >= 9:
                raise ProtocolError("Invalid Marionette frame length")
            prefix.extend(byte)
        if not prefix:
            raise ProtocolError("Missing Marionette frame length")
        length = int(prefix)
        if not 0 < length <= MAX_PACKET:
            raise ProtocolError("Marionette frame exceeds size limit")
        try:
            return json.loads(self._exact(length).decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        except (UnicodeError, ValueError, RecursionError) as exc:
            raise ProtocolError("Invalid Marionette JSON") from exc

    def command(self, name, parameters=None):
        if self.sock is None:
            raise ProtocolError("Marionette is not connected")
        self.sequence += 1
        try:
            self.sock.sendall(encode_packet([0, self.sequence, name, parameters or {}]))
            response = self.receive()
            if (not isinstance(response, list) or len(response) != 4 or type(response[0]) is not int
                    or response[0] != 1 or type(response[1]) is not int or response[1] != self.sequence):
                raise ProtocolError("Unexpected Marionette response sequence or type")
            if response[2] is not None:
                if (not isinstance(response[2], dict) or response[3] is not None
                        or any(not isinstance(response[2].get(key), str) for key in ("error", "message", "stacktrace"))):
                    raise ProtocolError("Invalid Marionette error object")
                raise RemoteError(response[2])
            return response[3]
        except RemoteError:
            raise
        except Exception:
            self.close()
            raise

    def start_session(self):
        result = self.command("WebDriver:NewSession", {})
        if not isinstance(result, dict) or not isinstance(result.get("sessionId"), str) or not isinstance(result.get("capabilities"), dict):
            raise ProtocolError("Invalid Marionette session response")
        self.session_id = result["sessionId"]
        return result["capabilities"]

    def chrome(self):
        self.command("Marionette:SetContext", {"value": "chrome"})

    def script(self, script, args=None, asynchronous=False):
        response = self.command("WebDriver:ExecuteAsyncScript" if asynchronous else "WebDriver:ExecuteScript", {
            "script": script, "args": args or [], "newSandbox": True,
            "sandbox": "zen-playground", "filename": "zen-playground", "line": 1,
        })
        if not isinstance(response, dict) or "value" not in response:
            raise ProtocolError("Invalid Marionette script response")
        return response["value"]

    def close(self):
        if self.sock is not None:
            try:
                self.sock.close()
            finally:
                self.sock = None
                self.session_id = None

    def disconnect(self):
        # DeleteSession releases remote automation; it never quits the browser.
        try:
            if self.session_id and self.sock is not None:
                self.command("WebDriver:DeleteSession")
        finally:
            self.close()
