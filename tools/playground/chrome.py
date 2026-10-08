"""Fixed, reviewed browser-chrome scripts. No caller-supplied evaluation."""

IDENTITY = r"""
// ZEN_PLAYGROUND_IDENTITY
const S = window.Services || Services;
const { RemoteAgent } = ChromeUtils.importESModule("chrome://remote/content/components/RemoteAgent.sys.mjs");
return {
  pid: S.appinfo.processID,
  profile: S.dirsvc.get("ProfD", Components.interfaces.nsIFile).path,
  binary: S.dirsvc.get("XREExeF", Components.interfaces.nsIFile).path,
  session_id: S.prefs.getStringPref("zen.playground.session_id", ""),
  marker: S.prefs.getStringPref("zen.playground.marker", ""),
  system_access: RemoteAgent.allowSystemAccess,
  port: S.prefs.getIntPref("marionette.port", 2828),
};
"""

MARK = r"""
// ZEN_PLAYGROUND_MARK
const S = window.Services || Services;
function mark(win) {
  if (!win.document || win.document.documentElement.getAttribute("windowtype") !== "navigator:browser") return;
  const root = win.document.documentElement;
  const modifier = root.getAttribute("titlemodifier") || "";
  if (!modifier.includes("[ZEN PLAYGROUND]")) root.setAttribute("titlemodifier", modifier + " [ZEN PLAYGROUND]");
  // Firefox 157 derives the actual native title from titlepreface, not titlemodifier.
  const preface = root.getAttribute("titlepreface") || "";
  if (!preface.includes("[ZEN PLAYGROUND]")) root.setAttribute("titlepreface", "[ZEN PLAYGROUND] " + preface);
  if (win.gBrowser) win.gBrowser.updateTitlebar();
  // Namespace stored only in this dedicated browser, never in a personal profile.
  if (!win.__zenPlaygroundTitleObserver) {
    const observer = new win.MutationObserver(() => {
      let changed = false;
      for (const attribute of ["titlemodifier", "titlepreface"]) {
        const current = root.getAttribute(attribute) || "";
        if (!current.includes("[ZEN PLAYGROUND]")) {
          root.setAttribute(attribute, attribute === "titlepreface" ? "[ZEN PLAYGROUND] " + current : current + " [ZEN PLAYGROUND]");
          changed = true;
        }
      }
      if (changed) win.gBrowser?.updateTitlebar();
    });
    observer.observe(root, {attributes: true, attributeFilter: ["titlemodifier", "titlepreface"]});
    win.__zenPlaygroundTitleObserver = observer;
  }
}
for (const win of S.wm.getEnumerator("navigator:browser")) mark(win);
const host = S.wm.getMostRecentWindow("navigator:browser");
if (host && !host.__zenPlaygroundWindowObserver) {
  const observer = {observe(subject) {
    subject.addEventListener("load", () => mark(subject), {once:true});
  }};
  S.obs.addObserver(observer, "domwindowopened");
  host.__zenPlaygroundWindowObserver = observer;
}
return window.document.documentElement.getAttribute("titlemodifier");
"""

STATE = r"""
// ZEN_PLAYGROUND_STATE
const S = window.Services || Services;
const gb = window.gBrowser;
const ws = window.gZenWorkspaces;
const tabs = gb ? Array.from(gb.tabs).map(t => ({
  id:t.id || "", label:t.label || "", url:t.linkedBrowser?.currentURI?.spec || "",
  selected:t === gb.selectedTab, pinned:!!t.pinned, hidden:!!t.hidden,
  space_id:t.getAttribute("zen-workspace-id") || null,
})) : [];
const spaces = ws && typeof ws.getWorkspaces === "function" ? ws.getWorkspaces().map(w => ({
  id:w.uuid, name:w.name || "", active:w.uuid === ws.activeWorkspace,
})) : [];
return {
  document_uri:document.documentURI, window_id:String(window.windowGlobalChild.outerWindowId),
  title:document.title, title_modifier:document.documentElement.getAttribute("titlemodifier"),
  title_preface:document.documentElement.getAttribute("titlepreface"),
  tabs, spaces, spaces_supported:!!ws && typeof ws.changeWorkspaceWithID === "function",
  windows:Array.from(S.wm.getEnumerator("navigator:browser")).map(w => ({
    id:String(w.windowGlobalChild.outerWindowId), title:w.document.title, current:w === window,
  })),
};
"""

VISIBILITY = r"""
function nativeMenuVisible(el) {
  if (!["menuitem", "menu"].includes(el.localName)) return false;
  const popup = el.closest("menupopup");
  if (!popup || popup.state !== "open") return false;
  for (let node = el; node && node !== popup; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (node.hidden || style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}
"""

INSPECT = VISIBILITY + r"""
// ZEN_PLAYGROUND_INSPECT
const [selector, includeHidden, limit] = arguments;
const elements = [];
let matched = 0;
// Firefox extension prompts place their buttons in an open shadow root.
// Keep native element references while inspecting only this chrome document.
const roots = [document], selected = [];
for (let index = 0; index < roots.length; index++) {
  if (roots.length > 1000) throw new Error("Chrome shadow-root inventory exceeds limit");
  const root = roots[index];
  selected.push(...root.querySelectorAll(selector));
  for (const node of root.querySelectorAll("*")) {
    if (node.shadowRoot) roots.push(node.shadowRoot);
  }
}
for (const el of selected) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const nativeMenu = nativeMenuVisible(el);
  const visible = nativeMenu || (!el.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0);
  if (!includeHidden && !visible) continue;
  matched++;
  if (elements.length >= limit) continue;
  const fingerprint = JSON.stringify([el.localName,el.id,el.getAttribute("label"),el.getAttribute("aria-label"),el.getAttribute("role"),el.getAttribute("data-l10n-id")]);
  elements.push({reference:el, fingerprint,
    tag:el.localName,id:el.id || null,role:el.getAttribute("role"),
    label:el.getAttribute("aria-label") || el.getAttribute("label") || el.getAttribute("title") || el.getAttribute("tooltiptext") || "",
    text:(el.textContent || "").replace(/\s+/g," ").trim().slice(0,240),
    l10n_id:el.getAttribute("data-l10n-id"), visible, native_menu:nativeMenu,
    disabled:!!el.disabled || el.getAttribute("disabled") === "true",
    rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
  });
}
return {document_key:document.documentURI + ":" + window.windowGlobalChild.outerWindowId, elements, matched, truncated:matched > limit};
"""

FRESH = VISIBILITY + r"""
// ZEN_PLAYGROUND_FRESH
const [el, documentKey, fingerprint] = arguments;
if (!el || !el.isConnected || el.ownerDocument !== document) return false;
if (document.documentURI + ":" + window.windowGlobalChild.outerWindowId !== documentKey) return false;
const now = JSON.stringify([el.localName,el.id,el.getAttribute("label"),el.getAttribute("aria-label"),el.getAttribute("role"),el.getAttribute("data-l10n-id")]);
const rect = el.getBoundingClientRect(), style = window.getComputedStyle(el);
return now === fingerprint && !el.hidden && !el.disabled && el.getAttribute("disabled") !== "true" && (nativeMenuVisible(el) || (style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0));
"""

HIT = r"""
// Reject a pointer click that would land on another element or a clipped Space.
const el = arguments[0], rect = el.getBoundingClientRect();
const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
let hit = document.elementFromPoint(x, y);
while (hit?.shadowRoot) {
  const inner = hit.shadowRoot.elementFromPoint(x, y);
  if (!inner || inner === hit) break;
  hit = inner;
}
return !!hit && (hit === el || el.contains(hit));
"""

OPEN_TAB = r"""
// ZEN_PLAYGROUND_OPEN_TAB
const tab = window.gBrowser.addTrustedTab(arguments[0], {skipAnimation:true});
window.gBrowser.selectedTab = tab;
return {id:tab.id || "", label:tab.label || ""};
"""

CLOSE_TAB = r"""
// ZEN_PLAYGROUND_CLOSE_TAB
const tab = arguments[0], gb = window.gBrowser;
if (!gb || !Array.from(gb.tabs).includes(tab)) throw new Error("Handle is not a browser tab");
if (gb.tabs.length <= 1) throw new Error("Refusing to close the last browser tab");
gb.removeTab(tab, {animate:false});
return true;
"""

SPACE = r"""
// ZEN_PLAYGROUND_SPACE
const [id, done] = arguments;
const ws = window.gZenWorkspaces;
if (!ws || typeof ws.changeWorkspaceWithID !== "function") { done({error:"Spaces API unavailable"}); return; }
if (!ws.getWorkspaces().some(w => w.uuid === id)) { done({error:"Space no longer exists"}); return; }
Promise.resolve(ws.changeWorkspaceWithID(id)).then(() => done({active:ws.activeWorkspace}), e => done({error:String(e)}));
"""
