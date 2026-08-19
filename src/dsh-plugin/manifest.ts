/**
 * DSH-facing Plugin Manifest
 *
 * 这里刻意保持非常小。
 * Model 不应该看到 SCA 内部几十个函数。
 */

export const SCA_DSH_PLUGIN_MANIFEST = {
  id: "sca",
  version: "1.0.0",
  name: "Sovereign Career Agent",
  description:
    "Career capability provider for DeepSeek Harness.",
  capability: "career",

  stateAuthorities: [
    "career_state",
    "mission_state",
    "evidence",
  ],

  capabilities: {
    search: {
      id: "career.search",
      mode: "mission",
      readOnly: true,
    },

    inspect: {
      id: "career.inspect",
      mode: "mission",
      readOnly: true,
    },

    apply: {
      id: "career.apply",
      mode: "mission",
      readOnly: false,
      requiresPolicy: true,
      mayRequireApproval: true,
    },

    mission: {
      id: "career.mission",
      mode: "runtime",
      // ⚠️ P1-4 Fix: Manifest must match declared capability surface.
      // README declares: status / pause / cancel / approve / deny
      // Previously missing: approve, deny
      operations: [
        "status",
        "pause",
        "cancel",
        "approve",
        "deny",
      ],
    },
  },

  forbiddenModelSurface: [
    "chrome.tabs.*",
    "chrome.scripting.*",
    "dom_selector",
    "css_selector",
    "xpath",
    "indexeddb_key",
    "tab_id",
    "wdl_locator",
    "internal_event_id",
  ],

  lifecycle: [
    "activate",
    "pause",
    "resume",
    "stop",
    "dispose",
  ],

  contract: {
    cognition: "DSH",
    capability: "SCA",
    reality: "SCA_PROVIDER",
  },
} as const;
