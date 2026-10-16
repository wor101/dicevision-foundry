import js from "@eslint/js";
import globals from "globals";

// Foundry's globals. Tests mock them on globalThis, and the e2e scripts use
// them inside page.evaluate(), so all three groups know about them.
const foundryGlobals = {
  ChatMessage: "readonly",
  CONFIG: "readonly",
  foundry: "readonly",
  game: "readonly",
  Hooks: "readonly",
  renderTemplate: "readonly",
  ui: "readonly"
};

export default [
  { ignores: ["node_modules/"] },
  js.configs.recommended,
  {
    // The module, running in the browser inside Foundry
    files: ["scripts/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...foundryGlobals } }
  },
  {
    files: ["tests/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...foundryGlobals } }
  },
  {
    // Node scripts that drive a browser
    files: ["scripts-dev/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...foundryGlobals } }
  },
  {
    files: ["eslint.config.js"],
    languageOptions: { globals: globals.node }
  }
];
