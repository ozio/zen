/* eslint-disable no-undef */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

var gZenMcpSettings = {
  _initialized: false,
  _disposed: true,
  _lifecycle: 0,
  _refreshRevision: 0,
  _grantEpoch: 0,
  _grant: null,
  _status: null,
  _service: null,

  _getService() {
    this._service ??= ChromeUtils.importESModule(
      "resource:///modules/zen/mcp/ZenMcpService.sys.mjs",
    ).ZenMcpService;
    return this._service;
  },

  _element(id) {
    return document.getElementById(id);
  },

  init() {
    if (this._initialized) {
      return this._initPromise;
    }
    if (!this._element("zenMcpEnabled")) {
      return Promise.resolve();
    }
    this._initialized = true;
    this._disposed = false;
    this._ready = false;
    this._busy = true;
    this._portDirty = false;
    this._active =
      typeof gLastCategory !== "undefined" &&
      gLastCategory.category === "paneZenMcp";
    this._listeners = [];
    const lifecycle = ++this._lifecycle;
    this._bindEvents();
    Services.obs.addObserver(this, "zen-mcp-state-changed");
    this._observing = true;
    this._initPromise = this._initializeService(lifecycle);
    return this._initPromise;
  },

  async _initializeService(lifecycle) {
    try {
      await this._getService().init();
      if (this._disposed || lifecycle !== this._lifecycle) {
        return;
      }
      await this._refresh();
      if (!this._disposed && lifecycle === this._lifecycle) {
        this._ready = true;
      }
    } catch {
      if (!this._disposed && lifecycle === this._lifecycle) {
        this._setError("zen-mcp-error-initialize");
      }
    } finally {
      if (!this._disposed && lifecycle === this._lifecycle) {
        this._busy = false;
        this._updateDisabled();
      }
    }
  },

  _listen(target, type, callback) {
    target.addEventListener(type, callback);
    this._listeners.push({ target, type, callback });
  },

  _bindEvents() {
    this._listen(this._element("zenMcpEnabled"), "command", () => {
      const enabled = this._element("zenMcpEnabled").checked;
      void this._runOperation(
        () => this._getService().setEnabled(enabled),
        "zen-mcp-error-enable",
      );
    });
    this._listen(this._element("zenMcpPort"), "input", () => {
      this._portDirty = true;
    });
    this._listen(this._element("zenMcpPort"), "keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this._applyPort();
      }
    });
    this._listen(this._element("zenMcpApplyPort"), "command", () => {
      void this._applyPort();
    });
    this._listen(this._element("zenMcpAddClient"), "command", () => {
      void this._createClient();
    });
    this._listen(this._element("zenMcpClientName"), "keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this._createClient();
      }
    });
    this._listen(this._element("zenMcpClientsList"), "command", (event) => {
      const button = event.target.closest("[data-mcp-client-action]");
      if (!button || !this._element("zenMcpClientsList").contains(button)) {
        return;
      }
      const id = button.getAttribute("data-client-id");
      if (!this._status?.clients.some((client) => client.id === id)) {
        return;
      }
      if (button.getAttribute("data-mcp-client-action") === "rotate") {
        void this._rotateClient(id);
      } else {
        void this._revokeClient(id);
      }
    });
    this._listen(this._element("zenMcpRefresh"), "command", () => {
      void this._runOperation(
        async () => {
          await this._getService().init();
        },
        "zen-mcp-error-refresh",
        () => {
          this._ready = true;
        },
        true,
      );
    });
    this._listen(this._element("zenMcpCopyEndpoint"), "command", () => {
      if (this._status?.endpoint) {
        this._copy(this._status.endpoint);
      }
    });
    for (const [id, property] of [
      ["zenMcpCopyToken", "token"],
      ["zenMcpCopyJson", "json"],
      ["zenMcpCopyCodex", "codex"],
    ]) {
      this._listen(this._element(id), "command", () => {
        if (this._grant && !this._busy) {
          this._copy(this._grant[property]);
        }
      });
    }
    this._listen(this._element("zenMcpDismissGrant"), "command", () => {
      this._clearGrant();
    });
    this._listen(document, "paneshown", (event) => {
      this._active = event.detail.category === "paneZenMcp";
      if (!this._active) {
        this._clearGrant();
      }
    });
    this._listen(window, "pagehide", () => {
      this._active = false;
      this._clearGrant();
    });
    this._listen(window, "pageshow", () => {
      this._active =
        typeof gLastCategory !== "undefined" &&
        gLastCategory.category === "paneZenMcp";
    });
    this._listen(window, "unload", () => {
      this.destroy();
    });
  },

  observe(_subject, topic, data) {
    if (topic !== "zen-mcp-state-changed" || this._disposed) {
      return;
    }
    let change;
    try {
      change = JSON.parse(data);
    } catch {
      // Older or unexpected notifications contain no credentials. Fail closed
      // for an already displayed grant rather than retaining stale access.
    }
    const pending = this._pendingGrant;
    const ownRotation =
      change?.kind === "clients:rotate" &&
      pending?.action === "rotate" &&
      pending.clientId === change.clientId &&
      !pending.observed;
    if (ownRotation) {
      pending.observed = true;
    } else if (
      ![
        "clients:create",
        "clients:rotate",
        "clients:revoke",
        "server:state",
      ].includes(change?.kind) ||
      change.kind === "server:state" ||
      ((change.kind === "clients:revoke" || change.kind === "clients:rotate") &&
        (this._grant?.clientId === change.clientId ||
          pending?.clientId === change.clientId ||
          pending?.action === "create"))
    ) {
      this._clearGrant();
    }
    if (this._ready) {
      void this._refresh().catch(() => {
        if (!this._disposed) {
          this._setError("zen-mcp-error-refresh");
        }
      });
    }
  },

  async _refresh() {
    const revision = ++this._refreshRevision;
    const lifecycle = this._lifecycle;
    const status = await this._getService().getStatus();
    if (
      this._disposed ||
      lifecycle !== this._lifecycle ||
      revision !== this._refreshRevision
    ) {
      return;
    }
    // Deliberately retain only the public status fields, never a grant response.
    this._status = {
      enabled: !!status.enabled,
      running: !!status.running,
      endpoint: status.endpoint,
      port: status.port,
      defaultPort: status.defaultPort,
      error: status.error,
      kind: status.kind,
      clients: (status.clients || []).map(
        ({ id, name, createdAt, lastUsedAt }) => ({
          id,
          name,
          createdAt,
          lastUsedAt,
        }),
      ),
    };
    this._renderStatus();
  },

  _renderStatus() {
    const status = this._status;
    this._element("zenMcpEnabled").checked = status.enabled;
    document.l10n.setAttributes(
      this._element("zenMcpStatus"),
      status.running
        ? "zen-mcp-status-running"
        : status.enabled
          ? "zen-mcp-status-stopped"
          : "zen-mcp-status-disabled",
    );
    document.l10n.setAttributes(
      this._element("zenMcpInstance"),
      status.kind === "playground"
        ? "zen-mcp-instance-playground"
        : "zen-mcp-instance-main",
    );
    document.l10n.setAttributes(
      this._element("zenMcpPortHint"),
      "zen-mcp-port-hint",
      { port: status.defaultPort },
    );
    if (!this._portDirty) {
      this._element("zenMcpPort").value = String(
        status.port || status.defaultPort,
      );
    }
    this._element("zenMcpEndpoint").value = status.endpoint || "";
    this._element("zenMcpServerError").hidden = !status.error;
    if (status.error) {
      document.l10n.setAttributes(
        this._element("zenMcpServerError"),
        "zen-mcp-server-error",
        { error: String(status.error) },
      );
    }
    if (
      this._grant &&
      (this._grant.endpoint !== status.endpoint ||
        !status.clients.some((client) => client.id === this._grant.clientId))
    ) {
      this._clearGrant();
    }
    this._renderClients();
    this._updateDisabled();
  },

  _date(value) {
    const date =
      typeof value === "number" ? value : value ? Date.parse(value) : NaN;
    return Number.isFinite(date) && date > 0 ? date : null;
  },

  _renderClients() {
    const fragment = document.createDocumentFragment();
    for (const client of this._status.clients) {
      const row = document.createXULElement("vbox");
      row.className = "indent";
      const heading = document.createXULElement("hbox");
      heading.setAttribute("align", "center");
      const name = document.createXULElement("label");
      name.setAttribute("flex", "1");
      name.setAttribute("crop", "end");
      name.setAttribute("value", client.name);
      heading.appendChild(name);
      for (const action of ["rotate", "revoke"]) {
        const button = document.createXULElement("button");
        button.setAttribute("data-client-id", client.id);
        button.setAttribute("data-mcp-client-action", action);
        document.l10n.setAttributes(button, `zen-mcp-client-${action}`);
        heading.appendChild(button);
      }
      row.appendChild(heading);
      const created = document.createXULElement("description");
      created.className = "description-deemphasized";
      const createdAt = this._date(client.createdAt);
      document.l10n.setAttributes(
        created,
        createdAt ? "zen-mcp-client-created" : "zen-mcp-client-created-unknown",
        createdAt ? { createdAt } : undefined,
      );
      row.appendChild(created);
      const used = document.createXULElement("description");
      used.className = "description-deemphasized";
      const lastUsedAt = this._date(client.lastUsedAt);
      document.l10n.setAttributes(
        used,
        lastUsedAt ? "zen-mcp-client-last-used" : "zen-mcp-client-unused",
        lastUsedAt ? { lastUsedAt } : undefined,
      );
      row.appendChild(used);
      fragment.appendChild(row);
    }
    this._element("zenMcpClientsList").replaceChildren(fragment);
    this._element("zenMcpClientsEmpty").hidden =
      this._status.clients.length > 0;
  },

  _updateDisabled() {
    const disabled = this._disposed || this._busy || !this._ready;
    for (const id of [
      "zenMcpEnabled",
      "zenMcpPort",
      "zenMcpApplyPort",
      "zenMcpClientName",
      "zenMcpAddClient",
    ]) {
      this._element(id).disabled = disabled;
    }
    for (const button of this._element("zenMcpClientsList").querySelectorAll(
      "button",
    )) {
      button.disabled = disabled;
    }
    this._element("zenMcpRefresh").disabled = this._disposed || this._busy;
    this._element("zenMcpCopyEndpoint").disabled =
      disabled || !this._status?.endpoint;
    for (const id of ["zenMcpCopyToken", "zenMcpCopyJson", "zenMcpCopyCodex"]) {
      this._element(id).disabled = this._disposed || this._busy || !this._grant;
    }
  },

  async _runOperation(
    operation,
    errorId,
    onSuccess = null,
    allowUnready = false,
  ) {
    if (this._disposed || this._busy || (!this._ready && !allowUnready)) {
      return;
    }
    const lifecycle = this._lifecycle;
    this._busy = true;
    this._element("zenMcpOperationError").hidden = true;
    this._element("zenMcpFeedback").hidden = true;
    this._updateDisabled();
    try {
      const result = await operation();
      if (this._disposed || lifecycle !== this._lifecycle) {
        return;
      }
      await this._refresh();
      if (!this._disposed && lifecycle === this._lifecycle) {
        onSuccess?.(result);
      }
    } catch {
      if (!this._disposed && lifecycle === this._lifecycle) {
        // Exceptions may contain arguments or credentials. Never print them or
        // use their text as a UI message.
        this._setError(errorId);
        try {
          await this._refresh();
        } catch {
          /* Keep the actionable UI error. */
        }
      }
    } finally {
      if (!this._disposed && lifecycle === this._lifecycle) {
        this._busy = false;
        this._updateDisabled();
      }
    }
  },

  async _applyPort() {
    if (this._busy || !this._ready || this._disposed) {
      return;
    }
    const input = this._element("zenMcpPort");
    const value = input.value.trim();
    const port = value === "" ? 0 : Number(value);
    if (
      input.validity.badInput ||
      (value !== "" &&
        (!/^\d+$/.test(value) ||
          !Number.isSafeInteger(port) ||
          port < 1 ||
          port > 65535))
    ) {
      this._setError("zen-mcp-error-port");
      this._element("zenMcpPort").focus();
      return;
    }
    await this._runOperation(async () => {
      await this._getService().setPort(port);
      this._portDirty = false;
    }, "zen-mcp-error-apply-port");
  },

  async _createClient() {
    if (this._busy || !this._ready || this._disposed) {
      return;
    }
    const name = this._element("zenMcpClientName").value.trim();
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
      this._setError("zen-mcp-error-name");
      this._element("zenMcpClientName").focus();
      return;
    }
    if (!(await this._activateForGrant())) {
      return;
    }
    await this._issueGrant(
      "create",
      null,
      () => this._getService().addClient(name),
      "zen-mcp-error-create",
      () => {
        this._element("zenMcpClientName").value = "";
      },
    );
  },

  async _rotateClient(id) {
    if (this._busy || !this._ready || this._disposed) {
      return;
    }
    if (!(await this._activateForGrant())) {
      return;
    }
    await this._issueGrant(
      "rotate",
      id,
      () => this._getService().rotateClient(id),
      "zen-mcp-error-rotate",
    );
  },

  async _activateForGrant() {
    const lifecycle = this._lifecycle;
    if (!this._active && typeof gotoPref === "function") {
      try {
        await gotoPref("paneZenMcp");
      } catch {
        if (!this._disposed && lifecycle === this._lifecycle) {
          this._setError("zen-mcp-error-open-pane");
        }
        return false;
      }
    }
    return (
      this._active &&
      !this._disposed &&
      lifecycle === this._lifecycle &&
      !this._busy
    );
  },

  async _issueGrant(action, clientId, operation, errorId, onSuccess = null) {
    if (this._busy || !this._ready || this._disposed || !this._active) {
      return;
    }
    this._clearGrant();
    const epoch = this._grantEpoch;
    const pending = (this._pendingGrant = {
      action,
      clientId,
      observed: false,
    });
    try {
      await this._runOperation(operation, errorId, (result) => {
        onSuccess?.();
        if (this._active && epoch === this._grantEpoch) {
          this._showGrant(result);
        }
      });
    } finally {
      if (this._pendingGrant === pending) {
        this._pendingGrant = null;
      }
    }
  },

  async _revokeClient(id) {
    if (this._busy || !this._ready || this._disposed) {
      return;
    }
    this._clearGrant();
    await this._runOperation(
      () => this._getService().revokeClient(id),
      "zen-mcp-error-revoke",
    );
  },

  _showGrant(result) {
    if (
      !result?.client?.id ||
      typeof result.token !== "string" ||
      !result.token ||
      typeof result.endpoint !== "string" ||
      result.endpoint !== this._status.endpoint ||
      !this._status.clients.some((client) => client.id === result.client.id)
    ) {
      throw new Error("Invalid client grant response");
    }
    const json =
      typeof result.configText === "string"
        ? result.configText
        : JSON.stringify(result.config, null, 2);
    if (!json) {
      throw new Error("Missing client connection configuration");
    }
    const serverName =
      this._status.kind === "playground" ? "zen_playground" : "zen";
    // Codex accepts static HTTP headers in config.toml:
    // https://developers.openai.com/codex/mcp#streamable-http-servers
    const codex =
      `[mcp_servers.${serverName}]\nurl = ${JSON.stringify(result.endpoint)}\n\n` +
      `[mcp_servers.${serverName}.http_headers]\nAuthorization = ${JSON.stringify(`Bearer ${result.token}`)}\n`;
    this._grant = {
      clientId: result.client.id,
      endpoint: result.endpoint,
      token: result.token,
      json,
      codex,
    };
    document.l10n.setAttributes(
      this._element("zenMcpGrantHeading"),
      "zen-mcp-grant-heading",
      { name: result.client.name },
    );
    this._element("zenMcpToken").value = result.token;
    this._element("zenMcpJsonConfig").value = json;
    this._element("zenMcpCodexConfig").value = codex;
    this._element("zenMcpGrant").hidden = false;
    this._updateDisabled();
  },

  _clearGrant() {
    ++this._grantEpoch;
    this._grant = null;
    for (const id of ["zenMcpToken", "zenMcpJsonConfig", "zenMcpCodexConfig"]) {
      const element = this._element(id);
      if (element) {
        element.value = "";
      }
    }
    const grant = this._element("zenMcpGrant");
    if (grant) {
      grant.hidden = true;
    }
    if (this._initialized) {
      this._updateDisabled();
    }
  },

  _copy(text) {
    try {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(text);
      this._element("zenMcpOperationError").hidden = true;
      document.l10n.setAttributes(
        this._element("zenMcpFeedback"),
        "zen-mcp-copied",
      );
      this._element("zenMcpFeedback").hidden = false;
    } catch {
      this._setError("zen-mcp-error-copy");
    }
  },

  _setError(id) {
    const element = this._element("zenMcpOperationError");
    document.l10n.setAttributes(element, id);
    element.hidden = false;
    this._element("zenMcpFeedback").hidden = true;
  },

  destroy() {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    ++this._lifecycle;
    ++this._refreshRevision;
    this._active = false;
    this._clearGrant();
    this._pendingGrant = null;
    if (this._observing) {
      Services.obs.removeObserver(this, "zen-mcp-state-changed");
      this._observing = false;
    }
    for (const { target, type, callback } of this._listeners) {
      target.removeEventListener(type, callback);
    }
    this._listeners = [];
    this._initialized = false;
    this._ready = false;
    this._status = null;
  },
};
