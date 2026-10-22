# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

zen-space-routing-settings =
    .label = Space Routing Settings
zen-space-routing-rulepanel-placeholder = Routes let you choose where specific sites open inside Zen. For example, you can route YouTube links to always open inside your Personal space.
zen-space-routing-dialog-title = Space Routing Settings
zen-space-routing-external-default = Default route for external links
zen-space-routing-new-route = New Route
zen-space-routing-open-in-space = Open in Space
zen-space-routing-most-recent-space = Most recent Space
zen-space-routing-close-button = 
    .aria-label = Close
    .tooltiptext = Close

zen-space-routing-contains =
    .label = Contains
zen-space-routing-equal-to =
    .label = Is Equal To
zen-space-routing-regex =
    .label = RegEx

zen-space-routing-open-in = Open In
zen-space-routing-url = URL

zen-space-routing-tab-routed-toast = New tab opened in { $targetWorkspace }
tab-context-zen-add-domain-to-sr = 
    .label = 
        { $tabCount ->
            [one] Add Route for Domain
            *[other] Add Route for Domains
        }

zen-space-routing-first-space = First Space
zen-space-routing-priority = Rules run from top to bottom. The first match wins.
zen-space-routing-ai-enabled = Use Jev for external links without a matching rule
zen-space-routing-ai-scope = Only links from other applications. Uncertain results and errors use the default Space below.
zen-space-routing-ai-settings = Jev settings
zen-space-routing-ai-key = TypeSafe API key
zen-space-routing-ai-save-key = Save key
zen-space-routing-ai-clear-key = Remove key
zen-space-routing-ai-check-key = Check connection
zen-space-routing-ai-prompt = Routing instructions
zen-space-routing-ai-reset-prompt = Restore default prompt
zen-space-routing-ai-spaces = Spaces and their purpose — included automatically
zen-space-routing-ai-probability = Minimum probability (%)
zen-space-routing-ai-margin = Lead over runner-up (points)
zen-space-routing-ai-timeout = Maximum wait (ms)
zen-space-routing-ai-privacy = Jev receives the link host and path, Space names, descriptions and your prompt. Query strings and fragments are removed. Pages and browsing history are not sent. Private windows, IP addresses and local hostnames skip Jev. The API key is stored encrypted in this profile.
zen-space-routing-preview = Try an external link
zen-space-routing-preview-run = Check destination without opening
zen-space-routing-preview-result = { $space } — { $reason }
zen-space-routing-unknown = Insufficient information
zen-space-routing-status-key-saved = Key saved securely.
zen-space-routing-status-checking = Checking…
zen-space-routing-status-connected = Jev connection verified.
zen-space-routing-status-rule = Matching rule
zen-space-routing-status-jev = Jev selected this Space
zen-space-routing-status-uncertain = Uncertain result; using default
zen-space-routing-status-disabled = Jev is off; using default
zen-space-routing-status-excluded-url = This address is not sent to Jev
zen-space-routing-status-excluded-window = Jev is unavailable in this window
zen-space-routing-status-missing-key = No saved API key.
zen-space-routing-status-invalid-key = API key was rejected.
zen-space-routing-status-service-error = Jev is unavailable; using default
zen-space-routing-status-timeout = Jev took too long; using default
zen-space-routing-status-cancelled = Request cancelled
zen-space-routing-status-busy = Too many requests; using default
zen-space-routing-status-invalid-response = Invalid Jev response; using default
zen-space-routing-status-invalid-spaces = Jev supports 1–254 Spaces
zen-space-routing-status-settings-changed = Settings changed; using default
zen-space-routing-status-failed = Could not complete the check. Verify the URL, settings and saved key.
zen-space-routing-url-mask =
    .label = URL mask
zen-space-routing-ai-description =
    .placeholder = What belongs in this Space?
zen-space-routing-move-up =
    .label = ↑
    .tooltiptext = Move rule up
zen-space-routing-move-down =
    .label = ↓
    .tooltiptext = Move rule down
