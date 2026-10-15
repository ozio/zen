---
name: zen-browser
description: Control the user's main Zen browser through its built-in MCP when a task requires tabs, Spaces, browser settings, web pages, screenshots, profile data, or DevTools.
---

# Zen browser

Use the built-in MCP server `zen` for the main Zen instance. Start with
`zen_browser_state` and verify the instance kind before acting. The browser must
be running with Settings → MCP → Enable the MCP server checked. Connection
credentials belong in the MCP client configuration, never in this skill.

Read the available tool schemas and the capabilities resource for the current
build. Use the returned `instanceId`, `windowId`, `tabId`, `frameId` and
`documentId` explicitly. A restart changes the instance identity; resolve targets
again. Reading paginated tab lists does not load unloaded tabs. Default pages
contain 100 entries; follow the returned cursor for more.

For page or browser UI interactions, take a fresh `zen_page_snapshot` or
`zen_chrome_snapshot`. Resolve an element from that snapshot immediately before
an action. Handles expire after 30 seconds, are consumed by one action, and
become invalid when their document is replaced. Navigation requires a new
snapshot. After an error or timeout, inspect the actual state before deciding
what to do: the action may already have happened. Do not repeat a mutation merely
because its response was lost.

For checkboxes, switches and radios, prefer `zen_page_action` with
`action: "check"` and the desired `checked` boolean over a toggling `click`.
Native checkbox/radio inputs and ARIA checkbox/switch/radio roles with explicit
`aria-checked` are supported. Checking an already satisfied state sends no
input. A radio can be checked, but cannot be unchecked this way.

Read the element's `actionability` alongside `visible`. A hidden native input
can be activated through its associated visible HTML label, and an offscreen
control can be scrolled into view by MCP. Target the control from the snapshot
and let MCP choose a safe activation point; do not reject it solely because
`visible` or `inViewport` is false. A label's `controlId` identifies its associated
HTML control; ARIA naming alone does not delegate activation. Avoid nested links
inside labels, and do not bypass disabled, inert or covered controls with DOM
state assignments. `input` can also follow an HTML label or resolve an ARIA
combobox/textbox/searchbox containing exactly one rendered editable descendant.

After `check`, `input`, `select` or `focus`, inspect `verification`: `verified`
means the requested state was observed; `already_satisfied` means no input was
needed. `not_applicable` requires a separate outcome check. On `state_mismatch`,
read the actual state or value: the page may reject or reformat input. Decide
the next step from that read-back rather than automatically repeating input.
For a replaced or repurposed element, obtain a new snapshot before another
action; do not reuse its old handle or silently substitute a new target.

Preserve unrelated windows, tabs, Spaces and profile data. Create temporary tabs
when useful for the task and close only those temporary targets afterward.
Prefer viewport screenshots. Use page tools for web content and chrome tools
for Zen menus, settings and sidebar controls. Inspect the resulting state after
each meaningful action.

Attach console/network observers only to explicitly requested targets. Start
them before the event being investigated, page through their records, and stop
them when finished. Keep an MCP subscription stream open during continuous
observation; disconnecting releases that client's observers. Cookies, storage,
history, downloads, extensions and typed preferences have dedicated tools.

Use `zen_javascript` with page scope for page evaluation. Browser scope executes
JavaScript with full browser privileges and can access private data, including
saved passwords and private browsing data. Apply the user's task scope when
choosing this capability. An asynchronous timeout cannot stop arbitrary
synchronous JavaScript. Prefer existing structured tools when they express the
requested action.

If the server is unavailable, ask the user to check its state and client access
in Zen's MCP settings. A revoked or replaced token requires a new configuration.
Do not silently connect to another browser profile or grant access yourself.
