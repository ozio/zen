"""Guarded native chrome inspection and actions for one clean playground."""

import base64
import time
import uuid
from urllib.parse import urlsplit

try:
    from . import chrome
    from .identity import Guard, Refusal
    from .marionette import ELEMENT_KEY, Marionette, ProtocolError
except ImportError:
    import chrome
    from identity import Guard, Refusal
    from marionette import ELEMENT_KEY, Marionette, ProtocolError

DEFAULT_SELECTOR = "toolbarbutton,button,input,textarea,select,[role],tab,menuitem,panel,zen-workspace"
SNAPSHOT_TTL = 30


class Bridge:
    def __init__(self, repo, guard=None, client_factory=Marionette):
        self.guard = guard or Guard(repo)
        self.client_factory = client_factory
        self.client = None
        self.record = None
        self.snapshot = None

    def close(self):
        self.snapshot = None
        if self.client:
            try:
                self.client.disconnect()
            finally:
                self.client = None
                self.record = None

    def verified(self):
        try:
            record = self.guard.validate()
            if self.client and record != self.record:
                self.close()
            if not self.client:
                self.client = self.client_factory(record["marionette_host"], record["marionette_port"])
                self.client.connect()
                caps = self.client.start_session()
                self.guard.capabilities(record, caps)
                self.client.chrome()
                self.guard.browser(record, self.client.script(chrome.IDENTITY))
                self.record = dict(record)
                self.client.script(chrome.MARK)
            else:
                self.client.chrome()
                self.guard.browser(record, self.client.script(chrome.IDENTITY))
            # Revalidate the file and process after the identity exchange too.
            if self.guard.validate() != record:
                raise Refusal("Launcher identity changed while connecting")
            return record
        except Exception:
            try:
                self.close()
            except Exception:
                # Preserve the identity/protocol refusal if cleanup also fails.
                pass
            raise

    def state(self):
        record = self.verified()
        state = self.client.script(chrome.STATE)
        if not isinstance(state, dict):
            raise ProtocolError("Invalid browser state")
        return {"identity": {key:record[key] for key in ("pid", "binary", "profile", "source_sha", "session_id", "marker")}, "browser": state}

    def inspect(self, selector=DEFAULT_SELECTOR, include_hidden=False, limit=300):
        self.verified()
        self.snapshot = None
        if not isinstance(selector, str) or not selector or len(selector) > 2048:
            raise ValueError("selector must be a CSS selector of 1..2048 characters")
        if type(include_hidden) is not bool or type(limit) is not int or not 1 <= limit <= 2000:
            raise ValueError("include_hidden must be boolean; limit must be 1..2000")
        data = self.client.script(chrome.INSPECT, [selector, include_hidden, limit])
        if (not isinstance(data, dict) or not isinstance(data.get("elements"), list)
                or len(data["elements"]) > limit or not isinstance(data.get("document_key"), str)):
            raise ProtocolError("Invalid chrome snapshot")
        snapshot_id = uuid.uuid4().hex
        handles, elements = {}, []
        for index, row in enumerate(data["elements"]):
            if (not isinstance(row, dict) or not isinstance(row.get("reference"), dict)
                    or not isinstance(row["reference"].get(ELEMENT_KEY), str) or not isinstance(row.get("fingerprint"), str)):
                raise ProtocolError("Chrome snapshot lacks native element reference")
            handle = snapshot_id[:12] + ":" + str(index)
            handles[handle] = row
            elements.append(dict((key, value) for key, value in row.items() if key not in ("reference", "fingerprint")))
            elements[-1]["handle"] = handle
        browser = self.client.script(chrome.STATE)
        self.snapshot = {"id":snapshot_id, "time":time.monotonic(), "document_key":data["document_key"], "handles":handles,
                         "spaces":{space["id"] for space in browser.get("spaces", [])}, "window_id":browser.get("window_id")}
        return {"snapshot_id":snapshot_id, "expires_in_seconds":SNAPSHOT_TTL, "elements":elements,
                "matched":data.get("matched"), "truncated":data.get("truncated"), "browser":browser}

    def _snapshot(self, snapshot_id):
        snapshot = self.snapshot
        if not snapshot or snapshot["id"] != snapshot_id or time.monotonic() - snapshot["time"] > SNAPSHOT_TTL:
            self.snapshot = None
            raise Refusal("Snapshot is unknown, expired or consumed; inspect chrome again")
        return snapshot

    def _element(self, snapshot_id, handle):
        snapshot = self._snapshot(snapshot_id)
        if not isinstance(handle, str) or handle not in snapshot["handles"]:
            raise Refusal("Element handle is not from the current snapshot")
        row = snapshot["handles"][handle]
        if self.client.script(chrome.FRESH, [row["reference"], snapshot["document_key"], row["fingerprint"]]) is not True:
            self.snapshot = None
            raise Refusal("Chrome element changed or is unavailable; inspect again")
        return row

    def click(self, snapshot_id, handle):
        self.verified()
        row = self._element(snapshot_id, handle)
        self.snapshot = None
        if row.get("native_menu"):
            # macOS renders these menus outside the DOM viewport. Marionette's
            # XUL click dispatches their command without inventing coordinates.
            self.client.command("WebDriver:ElementClick", {"id":row["reference"][ELEMENT_KEY]})
        else:
            if self.client.script(chrome.HIT, [row["reference"]]) is not True:
                raise Refusal("Another chrome element covers the click target; inspect again")
            # XUL ElementClick calls el.click(), which omits mousedown. Zen's
            # Create New button needs the actual pointer sequence to open its menu.
            try:
                self.client.command("WebDriver:PerformActions", {"actions":[{
                    "type":"pointer", "id":"zen-playground-pointer", "parameters":{"pointerType":"mouse"},
                    "actions":[{"type":"pointerMove", "duration":0, "origin":row["reference"], "x":0, "y":0},
                               {"type":"pointerDown", "button":0}, {"type":"pointerUp", "button":0}],
                }]})
            finally:
                self.client.command("WebDriver:ReleaseActions")
        return self.state()

    def input(self, snapshot_id, handle, text, clear=True):
        if not isinstance(text, str) or len(text) > 10000 or type(clear) is not bool:
            raise ValueError("text must be at most 10000 characters and clear must be boolean")
        self.verified()
        row = self._element(snapshot_id, handle)
        self.snapshot = None
        element_id = row["reference"][ELEMENT_KEY]
        if clear:
            self.client.command("WebDriver:ElementClear", {"id":element_id})
        self.client.command("WebDriver:ElementSendKeys", {"id":element_id, "text":text})
        return self.state()

    @staticmethod
    def _url(url):
        if not isinstance(url, str) or len(url) > 8192:
            raise ValueError("url must be a bounded string")
        parts = urlsplit(url)
        if url == "about:blank":
            return url
        if parts.scheme not in ("https", "http") or not parts.hostname or parts.username or parts.password or any(ord(char) < 32 for char in url):
            raise Refusal("Named tab actions permit HTTP(S) URLs without credentials, or about:blank")
        return url

    def tab(self, action, url=None, snapshot_id=None, handle=None):
        self.verified()
        if action == "open":
            url = self._url("about:blank" if url is None else url)
            self.snapshot = None
            self.client.script(chrome.OPEN_TAB, [url])
        elif action in ("select", "close"):
            row = self._element(snapshot_id, handle)
            if row.get("tag") != "tab":
                raise Refusal("Tab action requires a native browser tab handle")
            if action == "select":
                return self.click(snapshot_id, handle)
            self.snapshot = None
            self.client.script(chrome.CLOSE_TAB, [row["reference"]])
        else:
            raise ValueError("tab action must be open, select or close")
        return self.state()

    def space(self, snapshot_id, space_id):
        self.verified()
        snapshot = self._snapshot(snapshot_id)
        if not isinstance(space_id, str) or space_id not in snapshot["spaces"]:
            raise Refusal("Space ID is not from the current snapshot")
        current = self.client.script(chrome.STATE)
        if current.get("window_id") != snapshot["window_id"]:
            raise Refusal("Browser window changed; inspect again")
        self.snapshot = None
        result = self.client.script(chrome.SPACE, [space_id], asynchronous=True)
        if not isinstance(result, dict) or result.get("active") != space_id:
            raise Refusal("Space switch was not confirmed")
        return self.state()

    def screenshot(self):
        self.verified()
        result = self.client.command("WebDriver:TakeScreenshot", {"id":None, "full":False, "hash":False, "scroll":False})
        if not isinstance(result, dict) or not isinstance(result.get("value"), str):
            raise ProtocolError("Invalid chrome screenshot response")
        try:
            raw = base64.b64decode(result["value"], validate=True)
        except ValueError as exc:
            raise ProtocolError("Invalid screenshot encoding") from exc
        if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ProtocolError("Chrome screenshot is not a PNG")
        return result["value"]
