import base64
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import Bridge
import chrome
from identity import Guard, Refusal, process_identity
from marionette import ELEMENT_KEY, Marionette, ProtocolError, RemoteError, encode_packet
from server import MCPServer, MAX_LINE


class Fixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zen-guard-test-")
        self.repo = Path(self.temp.name).resolve()
        self.source = "a" * 40
        self.profile = self.repo / ".zen-local" / "profiles" / "playground"
        self.profile.mkdir(parents=True)
        artifact = self.repo / ".zen-local" / "artifacts" / self.source
        self.binary = artifact / "bundle" / "zen"
        self.binary.parent.mkdir(parents=True)
        self.binary.write_bytes(b"a dedicated fake executable")
        self.manifest = artifact / "artifact.json"
        self.record = {"binary":str(self.binary),"profile":str(self.profile),"pid":42123,"source_sha":self.source,
                       "marionette_host":"127.0.0.1","marionette_port":2828,"marker":"ZEN PLAYGROUND",
                       "session_id":"12345678-1234-4234-9234-123456789012","artifact_manifest":str(self.manifest)}
        self.manifest.write_text(json.dumps({"schema_version":1,"source_sha":self.source,"binary":str(self.binary),"binary_sha256":hashlib.sha256(self.binary.read_bytes()).hexdigest()}))
        self.write()
        self.process = {"binary":str(self.binary),"argv":[str(self.binary),"--no-remote","--profile",str(self.profile),"--marionette","--remote-allow-system-access"],"uid":os.getuid() if hasattr(os,"getuid") else None}
        self.guard = Guard(self.repo, process_reader=lambda pid:copy.deepcopy(self.process))

    def write(self):
        (self.repo / ".zen-local" / "state.json").write_text(json.dumps({"schema_version":1,"playground":self.record}))
        if self.profile.exists() and not self.profile.is_symlink():
            (self.profile / "zen-playground.json").write_text(json.dumps({"schema_version":1,"root":str(self.repo),"marker":"ZEN PLAYGROUND","session_id":self.record["session_id"]}))

    def browser(self):
        result = {key:self.record[key] for key in ("pid","binary","profile","session_id","marker")}
        result.update(system_access=True, port=2828)
        return result

    def close(self):
        self.temp.cleanup()


class FakeClient:
    def __init__(self, fixture):
        self.fixture = fixture
        self.calls = []
        self.caps = {"moz:processID":fixture.record["pid"],"moz:profile":fixture.record["profile"]}
        self.identity = fixture.browser()
        self.fresh = True
        self.disconnected = False

    def connect(self):
        self.calls.append(("connect",))

    def start_session(self):
        self.calls.append(("session",))
        return self.caps

    def chrome(self):
        self.calls.append(("chrome",))

    def script(self, script, args=None, asynchronous=False):
        self.calls.append((script,args))
        if script == chrome.IDENTITY:
            return dict(self.identity)
        if script == chrome.MARK:
            return "Zen [ZEN PLAYGROUND]"
        if script == chrome.STATE:
            return {"window_id":"1","tabs":[{"id":"tab-1"}],"spaces":[{"id":"space-1"}],"title":"[ZEN PLAYGROUND] test","title_modifier":"Zen [ZEN PLAYGROUND]"}
        if script == chrome.INSPECT:
            return {"document_key":"chrome://browser:1","matched":1,"truncated":False,"elements":[{
                "reference":{ELEMENT_KEY:"native-element-1"},"fingerprint":"fingerprint","tag":"tab","label":"test",
            }]}
        if script == chrome.FRESH:
            return self.fresh
        if script == chrome.SPACE:
            return {"active":args[0]}
        return True

    def command(self, name, params=None):
        self.calls.append((name,params))
        if name == "WebDriver:TakeScreenshot":
            return {"value":base64.b64encode(b"\x89PNG\r\n\x1a\nfake screenshot").decode("ascii")}
        return None

    def disconnect(self):
        self.disconnected = True


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)

    def test_positive_manifest_and_process_control(self):
        self.assertEqual(self.fixture.guard.validate(), self.fixture.record)

    def test_real_current_process_can_be_identified(self):
        actual = process_identity(os.getpid())
        self.assertTrue(Path(actual["binary"]).is_absolute())
        self.assertTrue(actual["argv"])
        if hasattr(os,"getuid"):
            self.assertEqual(actual["uid"], os.getuid())

    def test_main_profile_is_refused(self):
        personal = self.fixture.repo / "personal"
        personal.mkdir()
        self.fixture.record["profile"] = str(personal)
        self.fixture.write()
        with self.assertRaisesRegex(Refusal,"clean playground"):
            self.fixture.guard.validate()

    def test_symlink_profile_is_refused(self):
        (self.fixture.profile / "zen-playground.json").unlink()
        self.fixture.profile.rmdir()
        personal = self.fixture.repo / "personal"
        personal.mkdir()
        try:
            self.fixture.profile.symlink_to(personal, target_is_directory=True)
        except OSError:
            self.skipTest("Host does not permit symlink creation")
        with self.assertRaisesRegex(Refusal,"Symlinks"):
            self.fixture.guard.validate()

    def test_symlink_state_is_refused(self):
        state = self.fixture.repo / ".zen-local" / "state.json"
        contents = state.read_bytes()
        state.unlink()
        other = self.fixture.repo / "other.json"
        other.write_bytes(contents)
        try:
            state.symlink_to(other)
        except OSError:
            self.skipTest("Host does not permit symlink creation")
        with self.assertRaisesRegex(Refusal,"Symlinks"):
            self.fixture.guard.validate()

    def test_manifest_source_and_binary_hash_are_checked(self):
        self.fixture.binary.write_bytes(b"replaced executable")
        with self.assertRaisesRegex(Refusal,"hash"):
            self.fixture.guard.validate()

    def test_source_stamp_cannot_be_substituted(self):
        contents = json.loads(self.fixture.manifest.read_text())
        contents["source_sha"] = "b" * 40
        self.fixture.manifest.write_text(json.dumps(contents))
        with self.assertRaisesRegex(Refusal,"manifest"):
            self.fixture.guard.validate()

    def test_profile_marker_and_launch_uuid_are_independent_checks(self):
        marker = self.fixture.profile / "zen-playground.json"
        contents = json.loads(marker.read_text())
        contents["session_id"] = "old-session"
        marker.write_text(json.dumps(contents))
        with self.assertRaisesRegex(Refusal,"ownership marker"):
            self.fixture.guard.validate()
        self.fixture.record["session_id"] = "12345678123442349234123456789012"
        self.fixture.write()
        self.assertEqual(self.fixture.guard.validate()["session_id"],self.fixture.record["session_id"])

    def test_profile_userjs_cannot_link_to_personal_preferences(self):
        prefs = self.fixture.repo / "personal-user.js"
        prefs.write_text("personal preferences")
        try:
            (self.fixture.profile / "user.js").symlink_to(prefs)
        except OSError:
            self.skipTest("Host does not permit symlink creation")
        with self.assertRaisesRegex(Refusal,"Symlinks"):
            self.fixture.guard.validate()

    def test_host_port_pid_and_profile_arg_fail_closed(self):
        for field, value in (("marionette_host","localhost"),("marionette_host","0.0.0.0"),("marionette_port",True),("pid",True)):
            with self.subTest(field=field,value=value):
                saved = copy.deepcopy(self.fixture.record)
                self.fixture.record[field] = value
                self.fixture.write()
                with self.assertRaises(Refusal):
                    self.fixture.guard.validate()
                self.fixture.record = saved
                self.fixture.write()
        self.fixture.process["argv"][3] = str(self.fixture.repo)
        with self.assertRaisesRegex(Refusal,"exact playground profile"):
            self.fixture.guard.validate()

    def test_other_binary_and_ambiguous_profile_are_refused(self):
        self.fixture.process["binary"] = "/Applications/Zen.app/Contents/MacOS/zen"
        with self.assertRaisesRegex(Refusal,"executable"):
            self.fixture.guard.validate()
        self.fixture.process["binary"] = str(self.fixture.binary)
        self.fixture.process["argv"].extend(["--profile",str(self.fixture.profile)])
        with self.assertRaises(Refusal):
            self.fixture.guard.validate()

    def test_duplicate_keys_and_writable_state_are_refused(self):
        state = self.fixture.repo / ".zen-local" / "state.json"
        state.write_text('{"schema_version":1,"schema_version":1}')
        with self.assertRaisesRegex(Refusal,"Duplicate"):
            self.fixture.guard.validate()
        self.fixture.write()
        if os.name != "nt":
            state.chmod(0o666)
            with self.assertRaisesRegex(Refusal,"writable"):
                self.fixture.guard.validate()


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)
        self.fake = FakeClient(self.fixture)
        self.bridge = Bridge(self.fixture.repo, self.fixture.guard, client_factory=lambda *args:self.fake)
        self.addCleanup(self.bridge.close)

    def test_capabilities_checked_before_privileged_context(self):
        self.fake.caps["moz:processID"] += 1
        with self.assertRaisesRegex(Refusal,"another PID"):
            self.bridge.state()
        self.assertNotIn(("chrome",),self.fake.calls)
        self.assertFalse(any(call[0] == chrome.IDENTITY for call in self.fake.calls))
        self.assertTrue(self.fake.disconnected)

    def test_in_browser_profile_pid_binary_session_system_access_are_checked(self):
        for key, replacement in (("profile","/personal"),("pid",1),("binary","/Applications/Zen.app/zen"),("session_id","old-session"),("system_access",False),("port",2929)):
            with self.subTest(key=key):
                self.fake.identity = self.fixture.browser()
                self.fake.identity[key] = replacement
                self.fake.calls.clear()
                with self.assertRaisesRegex(Refusal,"In-browser"):
                    self.bridge.state()
                self.assertFalse(any(call[0] == chrome.MARK for call in self.fake.calls))

    def test_bad_identity_never_reaches_a_native_action(self):
        self.fake.identity["marker"] = "personal browser"
        with self.assertRaises(Refusal):
            self.bridge.tab("open",url="about:blank")
        self.assertFalse(any(call[0] == chrome.OPEN_TAB for call in self.fake.calls))

    def test_invalid_screenshot_is_not_reported_as_png(self):
        original = self.fake.command
        self.fake.command = lambda name, params=None: {"value":"invalid base64!"} if name == "WebDriver:TakeScreenshot" else original(name,params)
        with self.assertRaises(ProtocolError):
            self.bridge.screenshot()

    def test_positive_native_click_and_one_action_per_snapshot(self):
        result = self.bridge.inspect()
        handle = result["elements"][0]["handle"]
        self.bridge.click(result["snapshot_id"],handle)
        self.assertIn(("WebDriver:ElementClick",{"id":"native-element-1"}), self.fake.calls)
        with self.assertRaisesRegex(Refusal,"consumed"):
            self.bridge.click(result["snapshot_id"],handle)

    def test_expired_disconnected_changed_and_unknown_handles_are_refused(self):
        result = self.bridge.inspect()
        self.bridge.snapshot["time"] = time.monotonic() - 31
        with self.assertRaises(Refusal):
            self.bridge.click(result["snapshot_id"], result["elements"][0]["handle"])
        result = self.bridge.inspect()
        with self.assertRaises(Refusal):
            self.bridge.click(result["snapshot_id"],"invented-handle")
        self.fake.fresh = False
        with self.assertRaises(Refusal):
            self.bridge.click(result["snapshot_id"], result["elements"][0]["handle"])
        self.assertFalse(any(call[0] == "WebDriver:ElementClick" for call in self.fake.calls))

    def test_process_change_blocks_old_snapshot(self):
        result = self.bridge.inspect()
        self.fixture.process["argv"][3] = "/personal"
        with self.assertRaises(Refusal):
            self.bridge.click(result["snapshot_id"], result["elements"][0]["handle"])
        self.assertFalse(any(call[0] == "WebDriver:ElementClick" for call in self.fake.calls))

    def test_native_input_and_screenshot_parameters(self):
        result = self.bridge.inspect()
        self.bridge.input(result["snapshot_id"],result["elements"][0]["handle"],"日本語")
        self.assertIn(("WebDriver:ElementClear",{"id":"native-element-1"}),self.fake.calls)
        self.assertIn(("WebDriver:ElementSendKeys",{"id":"native-element-1","text":"日本語"}),self.fake.calls)
        self.assertTrue(self.bridge.screenshot())
        self.assertIn(("WebDriver:TakeScreenshot",{"id":None,"full":False,"hash":False,"scroll":False}),self.fake.calls)

    def test_browser_actions_limit_urls_and_spaces(self):
        for url in ("file:///personal","chrome://browser/content/browser.xhtml","javascript:1","https://name:secret@example.com"):
            with self.subTest(url=url), self.assertRaises(Refusal):
                self.bridge.tab("open",url=url)
        self.bridge.tab("open",url="https://example.com")
        result = self.bridge.inspect()
        with self.assertRaises(Refusal):
            self.bridge.space(result["snapshot_id"],"not-a-space")
        self.bridge.space(result["snapshot_id"],"space-1")
        self.assertTrue(any(call[0] == chrome.SPACE for call in self.fake.calls))


class FramingTests(unittest.TestCase):
    def client_pair(self):
        client_sock, remote = socket.socketpair()
        client_sock.settimeout(2)
        remote.settimeout(2)
        client = Marionette()
        client.sock = client_sock
        self.addCleanup(client.close)
        self.addCleanup(remote.close)
        return client,remote

    def test_utf8_length_fragmentation_and_coalesced_packets(self):
        client,remote = self.client_pair()
        packet = encode_packet({"text":"日本語"}) + encode_packet([1,1,None,{"value":"next"}])
        def send():
            for byte in packet:
                remote.sendall(bytes([byte]))
        worker = threading.Thread(target=send)
        worker.start()
        self.assertEqual(client.receive(),{"text":"日本語"})
        self.assertEqual(client.receive(),[1,1,None,{"value":"next"}])
        worker.join()

    def test_invalid_prefix_oversize_json_and_truncation(self):
        for packet in (b"x:{}",b":{}",b"33554433:",b"1:\xff",b"2:{x",b"5:{}"):
            with self.subTest(packet=packet):
                client,remote = self.client_pair()
                remote.sendall(packet)
                remote.shutdown(socket.SHUT_WR)
                with self.assertRaises(ProtocolError):
                    client.receive()

    def test_excessively_nested_marionette_json_is_protocol_error(self):
        client,remote = self.client_pair()
        body = b"[" * 2000 + b"0" + b"]" * 2000
        remote.sendall(str(len(body)).encode("ascii") + b":" + body)
        with self.assertRaises(ProtocolError):
            client.receive()

    def test_bad_response_id_closes_socket(self):
        client,remote = self.client_pair()
        remote.sendall(encode_packet([1,99,None,{}]))
        with self.assertRaisesRegex(ProtocolError,"sequence"):
            client.command("test")
        self.assertIsNone(client.sock)

    def test_error_response_is_not_success(self):
        client,remote = self.client_pair()
        remote.sendall(encode_packet([1,1,{"error":"stale element reference","message":"changed","stacktrace":"private-stack"},None]))
        with self.assertRaisesRegex(RemoteError,"stale element reference") as context:
            client.command("test")
        self.assertNotIn("private-stack",str(context.exception))

    def test_malformed_error_object_is_protocol_error(self):
        client,remote = self.client_pair()
        remote.sendall(encode_packet([1,1,{"error":"stale element reference"},None]))
        with self.assertRaises(ProtocolError):
            client.command("test")
        self.assertIsNone(client.sock)

    def test_real_loopback_fake_server_greeting_and_commands(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1",0))
        listener.listen(1)
        self.addCleanup(listener.close)
        commands = []
        def fake_server():
            peer,_ = listener.accept()
            remote = Marionette()
            remote.sock = peer
            try:
                peer.sendall(encode_packet({"applicationType":"gecko","marionetteProtocol":3}))
                command = remote.receive()
                commands.append(command)
                response = [1,command[1],None,{"sessionId":"test-session","capabilities":{"moz:profile":"test"}}]
                for segment in (encode_packet(response)[:3],encode_packet(response)[3:]):
                    peer.sendall(segment)
            finally:
                remote.close()
        worker = threading.Thread(target=fake_server)
        worker.start()
        client = Marionette(port=listener.getsockname()[1],timeout=2)
        self.addCleanup(client.close)
        client.connect()
        self.assertEqual(client.start_session(),{"moz:profile":"test"})
        worker.join()
        self.assertEqual(commands,[[0,1,"WebDriver:NewSession",{}]])


class MCPTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)
        self.fake = FakeClient(self.fixture)
        self.bridge = Bridge(self.fixture.repo,self.fixture.guard,client_factory=lambda *args:self.fake)
        self.addCleanup(self.bridge.close)
        self.server = MCPServer(self.bridge)
        self.server.dispatch({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"test","version":"1"},"capabilities":{}}})
        self.server.dispatch({"jsonrpc":"2.0","method":"notifications/initialized"})

    def call(self,name,args=None):
        return self.server.dispatch({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args or {}}})

    def test_tools_and_native_dispatch(self):
        tools = self.server.dispatch({"jsonrpc":"2.0","id":1,"method":"tools/list"})["result"]["tools"]
        self.assertEqual(len(tools),7)
        result = json.loads(self.call("playground_inspect")["result"]["content"][0]["text"])
        response = self.call("playground_click", {"snapshot_id":result["snapshot_id"],"handle":result["elements"][0]["handle"]})
        self.assertFalse(response["result"].get("isError"))

    def test_invalid_arguments_and_unknown_methods(self):
        for name,args in (("missing",{}),("playground_click",{}),("playground_inspect",{"limit":True}),("playground_state",{"eval":"malicious"}),("playground_tabs",{"action":"close"}),("playground_tabs",{"action":"open","handle":"irrelevant"})):
            with self.subTest(name=name,args=args):
                self.assertEqual(self.call(name,args)["error"]["code"],-32602)
        self.assertEqual(self.server.dispatch({"jsonrpc":"2.0","id":1,"method":"bad"})["error"]["code"],-32601)

    def test_refusal_is_tool_error_and_stderr_never_echoes_arguments(self):
        self.fixture.process["argv"][3] = "/personal"
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            response = self.call("playground_input", {"snapshot_id":"old","handle":"old","text":"secret-password"})
        self.assertTrue(response["result"]["isError"])
        self.assertNotIn("secret-password", errors.getvalue() + json.dumps(response))
        self.assertFalse(self.fake.calls)

    def test_json_lines_bad_json_notifications_and_no_stdout_noise(self):
        messages = [b"{bad json}\n",b'{"jsonrpc":"2.0","method":"notifications/cancelled"}\n','{"jsonrpc":"2.0","id":"日本語","method":"ping"}\n'.encode("utf-8")]
        incoming = io.BytesIO(b"".join(messages))
        outgoing = io.BytesIO()
        self.server.serve(incoming,outgoing)
        lines = outgoing.getvalue().splitlines()
        self.assertEqual(len(lines),2)
        self.assertEqual(json.loads(lines[0])["error"]["code"],-32700)
        self.assertEqual(json.loads(lines[1])["id"],"日本語")

    def test_duplicate_rpc_keys_and_nonfinite_numbers_are_parse_errors(self):
        for raw in (b'{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}\n', b'{"jsonrpc":"2.0","id":NaN,"method":"ping"}\n'):
            incoming,outgoing = io.BytesIO(raw),io.BytesIO()
            self.server.serve(incoming,outgoing)
            self.assertEqual(json.loads(outgoing.getvalue())["error"]["code"],-32700)

    def test_initialize_phase_cannot_be_bypassed(self):
        server = MCPServer(self.bridge)
        response = server.dispatch({"jsonrpc":"2.0","id":1,"method":"tools/list"})
        self.assertEqual(response["error"]["code"],-32002)
        invalid = server.dispatch({"jsonrpc":"2.0","id":True,"method":"ping"})
        self.assertIsNone(invalid["id"])

    def test_oversized_stdio_request_resynchronizes(self):
        incoming = io.BytesIO(b" " * (MAX_LINE + 5) + b"\n" + b'{"jsonrpc":"2.0","id":5,"method":"ping"}\n')
        outgoing = io.BytesIO()
        self.server.serve(incoming,outgoing)
        responses = [json.loads(line) for line in outgoing.getvalue().splitlines()]
        self.assertEqual(responses[0]["error"]["code"],-32700)
        self.assertEqual(responses[1]["id"],5)

    def test_excessively_nested_stdio_json_does_not_crash_server(self):
        incoming = io.BytesIO(b"[" * 2000 + b"0" + b"]" * 2000 + b"\n")
        outgoing = io.BytesIO()
        self.server.serve(incoming,outgoing)
        self.assertEqual(json.loads(outgoing.getvalue())["error"]["code"],-32700)


if __name__ == "__main__":
    unittest.main()
