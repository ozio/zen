"""Run current MCP sources in an identity-checked isolated Gecko Playground.

Requires a packaged Playground from the current committed source. Exercises
the actual production provider and actor; this is not a full release receipt.
Never connects to the daily browser or uses personal MCP grants.
"""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import subprocess
import uuid

try:
    from .bridge import Bridge
except ImportError:
    from bridge import Bridge


class Fixture(BaseHTTPRequestHandler):
    page = b""

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = (b'<!doctype html><label><input id="frame-check" type="checkbox">Frame checkbox</label>'
                if self.path == "/frame" else self.page)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Probe:
    def __init__(self, repo):
        self.repo = repo
        self.bridge = Bridge(repo)
        self.results = []

    def chrome(self, source, args=None):
        self.bridge.verified()
        result = self.bridge.client.script(
            "const done=arguments[arguments.length-1]; (async()=>{" + source +
            "})().then(done, error=>done({probeError:String(error),stack:error.stack}));",
            args or [], asynchronous=True)
        if isinstance(result, dict) and "probeError" in result:
            raise AssertionError(result)
        return result

    def call(self, name, args=None):
        return self.chrome("""
          const win=Services.wm.getMostRecentWindow('navigator:browser');
          const probe=win.__zenInteractionProbe;
          try { return await probe.provider.execute(arguments[0],
            {instanceId:probe.instanceId,tabId:probe.tabId,...arguments[1]}, {id:probe.clientId}); }
          catch(error) { return {error:{code:error.code,message:error.message}}; }
        """, [name, args or {}])

    def snapshot(self, selector, frame=None):
        result = self.call("zen_page_snapshot", {"selector": selector, **({"frameId": frame} if frame else {})})
        assert "error" not in result, result
        return result

    def act(self, selector, action="check", frame=None, expect=None, **kwargs):
        snapshot = self.snapshot(selector, frame)
        assert len(snapshot["elements"]) == 1, snapshot
        result = self.call("zen_page_action", {
            "frameId": snapshot["frameId"], "documentId": snapshot["documentId"],
            "snapshotId": snapshot["snapshotId"], "elementId": snapshot["elements"][0]["elementId"],
            "action": action, "timeoutMs": 1000, **({"checked": True} if action == "check" else {}), **kwargs})
        if expect:
            assert result.get("error", {}).get("code") == expect, result
        else:
            assert "error" not in result, result
        return result

    def observed(self):
        result = self.call("zen_page_text", {"selector": "#observations"})
        return json.loads(result["text"])

    def check(self, name, fn):
        fn()
        self.results.append({"name": name, "result": "pass"})
        print(json.dumps(self.results[-1]), flush=True)

    def run(self):
        record = self.bridge.verified()
        expected = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.repo, capture_output=True, text=True, check=True).stdout.strip()
        assert record['source_sha'] == expected, 'Build/package/run the current source before live validation'
        Fixture.page = (self.repo / "tests/mcp/fixtures/controls.html").read_bytes()
        server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = "http://127.0.0.1:" + str(server.server_port)
        try:
            self.chrome("""
              const [url,clientId]=arguments;
              const win=Services.wm.getMostRecentWindow('navigator:browser');
              if(win.__zenInteractionProbe) throw new Error('Another interaction probe is active');
              const {ZenMcpService:service}=ChromeUtils.importESModule('resource:///modules/zen/mcp/ZenMcpService.sys.mjs');
              await service.init();
              const wasEnabled=service.getStatus().enabled;
              if(!wasEnabled) await service.setEnabled(true);
              const original=win.gBrowser.selectedTab;
              const tab=win.gBrowser.addTab(url,{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal(),skipRoute:true});
              tab.setAttribute('zen-interaction-probe',clientId);
              win.__zenInteractionProbe={tab,original,clientId,service,wasEnabled,provider:service.pageTools,instanceId:service.instanceId,tabId:service.tabId(tab)};
              win.gBrowser.selectedTab=tab;
              await new Promise(resolve=>{const poll=()=>{if(tab.linkedBrowser.currentURI.spec===url&& !tab.linkedBrowser.webProgress.isLoadingDocument)resolve();else win.setTimeout(poll,30);};poll();});
              return true;
            """, [base + "/", "interaction-probe-" + uuid.uuid4().hex])

            def labelled():
                first = self.act("#offscreen")
                assert first["activation"]["via"] == "label", first
                assert self.act("#offscreen")["verification"] == "already_satisfied"
                self.act("#hidden")
                state = self.observed()
                assert state["activations"]["offscreen"] == state["activations"]["hidden"] == 1 and state["links"] == 0, state
            self.check("hidden inputs, associated labels, embedded links and idempotence", labelled)

            def aria():
                for selector in ["#aria-check", "#switch", "#radio", "#mixed"]:
                    assert self.act(selector)["verification"] == "verified"
                self.act("#radio", checked=False, expect="wrong_control")
            self.check("native-independent ARIA checkbox/switch/radio/mixed state", aria)

            def rejected():
                self.act("#revert", expect="state_mismatch", timeoutMs=160)
                self.act("#replace", expect="stale_element")
                state = self.observed()
                assert state["activations"]["revert"] == state["activations"]["replace"] == 1, state
            self.check("controlled rejection and rerender never cause repeated activation", rejected)

            def editors():
                for selector in ["#text-label", "#combo", "#editable"]:
                    assert self.act(selector, action="input", text="synthetic value")["verification"] == "verified"
                self.act("#readonly", action="input", text="forbidden", expect="readonly_control")
                assert self.act("#choice", action="select", values=["two"])["verification"] == "verified"
            self.check("labels, composite editors, contenteditable and retained selection", editors)

            def refused():
                for selector in ["#disabled", "#aria-disabled"]:
                    self.act(selector, expect="disabled_element")
                self.act("#inert", action="click", expect="disabled_element")
                self.act("#covered", action="click", expect="click_intercepted", timeoutMs=128)
                self.act("#moving", action="click", expect="unstable_element", timeoutMs=160)
                assert "covered" not in self.observed()["activations"]
                assert "moving" not in self.observed()["activations"]
                self.act("#release-cover", action="click")
                self.act("#covered", action="click")
            self.check("disabled/inert/covered/moving controls and bounded waiting", refused)

            def frames():
                self.act("#shadow-check")
                frames = self.call("zen_page_frames")["items"]
                child = next(item for item in frames if item.get("url") == base + "/frame")
                self.act("#frame-check", frame=child["frameId"])
                assert self.snapshot("#frame-check", child["frameId"])["elements"][0]["checked"] is True
            self.check("open shadow roots and explicitly targeted iframe controls", frames)

            def keyboard():
                result = self.act("#keyboard", timeoutMs=128)
                assert result["activation"]["via"] == "keyboard", result
                assert self.observed()["activations"]["keyboard"] == 1
            self.check("native keyboard activation of focusable offscreen controls", keyboard)
            final = self.observed()
            assert final["untrusted"] == 0 and final["links"] == 0, final
            receipt = {"result": "pass", "runtime": "production MCP provider and actor in isolated packaged Gecko",
                       "runtime_source_sha": record["source_sha"],
                       "binary_sha256": record["binary_sha256"], "checks": self.results, "observed": final}
            (self.repo / ".zen-local/mcp-interaction/live.json").write_text(json.dumps(receipt, indent=2) + "\n")
            print("MCP_INTERACTION_LIVE_PASS", flush=True)
        finally:
            try:
                self.bridge.close()
                self.chrome("""
                  const win=Services.wm.getMostRecentWindow('navigator:browser'),probe=win.__zenInteractionProbe;
                  if(probe){await probe.provider.cleanup(probe.clientId); if(!probe.tab.closing)win.gBrowser.removeTab(probe.tab,{animate:false,skipPermitUnload:true});
                    if(!probe.original.closing)win.gBrowser.selectedTab=probe.original;
                    if(!probe.wasEnabled)await probe.service.setEnabled(false);delete win.__zenInteractionProbe;}
                  return true;
                """)
            finally:
                server.shutdown()
                server.server_close()
                self.bridge.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    Probe(args.repo.resolve()).run()


if __name__ == "__main__":
    main()
