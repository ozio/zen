/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { gZenSpaceRoutingAI } = ChromeUtils.importESModule(
  "resource:///modules/zen/spacerouting/ZenSpaceRoutingAI.sys.mjs"
);
// eslint-disable-next-line no-shadow
const { gZenSpaceRoutingManager } = ChromeUtils.importESModule(
  "resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs"
);
const { DEFAULT_ROUTING_PROMPT, UNKNOWN_SPACE } = ChromeUtils.importESModule(
  "resource:///modules/zen/spacerouting/ZenSpaceRoutingPolicy.sys.mjs"
);
const { PrivateBrowsingUtils: routingPrivacy } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
);

export class ZenSpaceRoutingAISettings {
  constructor(doc, win) {
    this.doc = doc;
    this.win = win;
    this.events = new AbortController();
    this.preview = null;
    this.spaceChange = () => this.renderSpaces();
  }

  element(id) {
    return this.doc.getElementById(`sr-${id}`);
  }

  listen(id, event, callback) {
    this.element(id).addEventListener(
      event,
      () => {
        Promise.resolve()
          .then(callback)
          .catch(() => this.status("ai-status", "failed"));
      },
      { signal: this.events.signal }
    );
  }

  async init() {
    this.settings = await gZenSpaceRoutingAI.getSettings();
    if (this.events.signal.aborted) {
      return;
    }
    this.element("ai-enabled").checked = this.settings.enabled;
    this.element("ai-prompt").value = this.settings.prompt;
    this.element("ai-probability").value = Math.round(
      this.settings.minProbability * 100
    );
    this.element("ai-margin").value = Math.round(this.settings.minMargin * 100);
    this.element("ai-timeout").value = this.settings.timeoutMs;
    this.status(
      "ai-status",
      this.settings.hasKey ? "key-saved" : "missing-key"
    );
    this.renderSpaces();
    if (routingPrivacy.isWindowPrivate(this.win)) {
      for (const field of this.doc.querySelectorAll(
        "#sr-ai input, #sr-ai textarea, #sr-ai button, #sr-preview button"
      )) {
        field.disabled = true;
      }
      this.status("ai-status", "excluded-window");
      return;
    }
    this.win.addEventListener("ZenWorkspaceDataChanged", this.spaceChange);
    for (const [id, key, event, read] of [
      ["ai-enabled", "enabled", "change", el => el.checked],
      ["ai-prompt", "prompt", "input", el => el.value],
      [
        "ai-probability",
        "minProbability",
        "change",
        el => Number(el.value) / 100,
      ],
      ["ai-margin", "minMargin", "change", el => Number(el.value) / 100],
      ["ai-timeout", "timeoutMs", "change", el => Number(el.value)],
    ]) {
      this.listen(id, event, async () => {
        this.settings[key] = read(this.element(id));
        await this.save();
      });
    }
    this.listen("ai-reset-prompt", "click", async () => {
      this.element("ai-prompt").value = DEFAULT_ROUTING_PROMPT;
      this.settings.prompt = DEFAULT_ROUTING_PROMPT;
      await this.save();
    });
    this.listen("ai-save-key", "click", async () => {
      const field = this.element("ai-key");
      const key = field.value;
      field.value = "";
      await gZenSpaceRoutingAI.saveKey(key);
      this.status("ai-status", key.trim() ? "key-saved" : "missing-key");
    });
    this.listen("ai-clear-key", "click", async () => {
      this.element("ai-key").value = "";
      await gZenSpaceRoutingAI.saveKey("");
      this.status("ai-status", "missing-key");
    });
    this.listen("ai-check-key", "click", async () => {
      this.element("ai-check-key").disabled = true;
      this.status("ai-status", "checking");
      try {
        const result = await gZenSpaceRoutingAI.classify(
          "https://example.com/",
          this.win.gZenWorkspaces.getWorkspaces(),
          { preview: true, signal: this.events.signal }
        );
        this.status(
          "ai-status",
          result.probabilities ? "connected" : result.reason
        );
      } finally {
        this.element("ai-check-key").disabled = false;
      }
    });
    this.listen("preview-run", "click", () => this.runPreview());
  }

  async save() {
    await gZenSpaceRoutingAI.saveSettings(this.settings);
  }

  renderSpaces() {
    const root = this.element("ai-spaces");
    root.replaceChildren();
    for (const space of this.win.gZenWorkspaces.getWorkspaces()) {
      const label = this.doc.createElement("label");
      const spaceName = this.doc.createElement("span");
      spaceName.textContent = space.name;
      const input = this.doc.createElement("input");
      input.type = "text";
      input.maxLength = 1000;
      input.value = this.settings.descriptions[space.uuid] || "";
      this.doc.l10n.setAttributes(input, "zen-space-routing-ai-description");
      input.addEventListener(
        "input",
        () => {
          this.settings.descriptions[space.uuid] = input.value;
          this.save().catch(() => this.status("ai-status", "failed"));
        },
        { signal: this.events.signal }
      );
      label.append(spaceName, input);
      root.append(label);
    }
  }

  status(id, reason) {
    this.doc.l10n.setAttributes(
      this.element(id),
      `zen-space-routing-status-${reason}`
    );
  }

  async runPreview() {
    this.preview?.abort();
    const controller = new AbortController();
    this.preview = controller;
    this.element("preview-probabilities").replaceChildren();
    this.status("preview-result", "checking");
    try {
      const url = this.element("preview-url").value.trim();
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Invalid URL");
      }
      const result = await gZenSpaceRoutingManager.resolveExternalURI(
        parsed.href,
        this.win,
        { signal: controller.signal }
      );
      if (controller.signal.aborted) {
        return;
      }
      const spaces = this.win.gZenWorkspaces.getWorkspaces();
      const target = spaces.find(space => space.uuid === result.spaceId);
      const reason = await this.doc.l10n.formatValue(
        `zen-space-routing-status-${result.reason}`
      );
      this.doc.l10n.setAttributes(
        this.element("preview-result"),
        "zen-space-routing-preview-result",
        {
          space: target?.name || "—",
          reason,
        }
      );
      for (const entry of result.probabilities || []) {
        const row = this.doc.createElement("div");
        const spaceName =
          entry.spaceId === UNKNOWN_SPACE
            ? await this.doc.l10n.formatValue("zen-space-routing-unknown")
            : spaces.find(space => space.uuid === entry.spaceId)?.name ||
              entry.spaceId;
        row.textContent = `${spaceName}: ${(entry.probability * 100).toFixed(1)}%`;
        this.element("preview-probabilities").append(row);
      }
    } catch {
      if (!controller.signal.aborted) {
        this.status("preview-result", "failed");
      }
    }
  }

  destroy() {
    this.preview?.abort();
    this.events.abort();
    this.win.removeEventListener("ZenWorkspaceDataChanged", this.spaceChange);
    this.element("ai-key").value = "";
  }
}
