const MODULE_ID = "dicevision";

/**
 * Register all DiceVision module settings.
 * All settings are scope: "client" (per-user, not per-world).
 */
export function registerSettings() {
  game.settings.register(MODULE_ID, "sessionCode", {
    name: "DICEVISION.Settings.SessionCode.Name",
    hint: "DICEVISION.Settings.SessionCode.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "",
    onChange: (value) => {
      Hooks.callAll("dicevision.sessionCodeChanged", value);
    }
  });

  game.settings.register(MODULE_ID, "mode", {
    name: "DICEVISION.Settings.Mode.Name",
    hint: "DICEVISION.Settings.Mode.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "off",
    choices: {
      off: "DICEVISION.Settings.Mode.Off",
      chat: "DICEVISION.Settings.Mode.Chat",
      replace: "DICEVISION.Settings.Mode.Replace"
    },
    onChange: (value) => {
      Hooks.callAll("dicevision.modeChanged", value);
    }
  });

  game.settings.register(MODULE_ID, "continuous", {
    name: "DICEVISION.Settings.Continuous.Name",
    hint: "DICEVISION.Settings.Continuous.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => {
      Hooks.callAll("dicevision.continuousChanged", value);
    }
  });

  game.settings.register(MODULE_ID, "autoConnect", {
    name: "DICEVISION.Settings.AutoConnect.Name",
    hint: "DICEVISION.Settings.AutoConnect.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "chatVisibility", {
    name: "DICEVISION.Settings.ChatVisibility.Name",
    hint: "DICEVISION.Settings.ChatVisibility.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "all",
    choices: {
      all: "DICEVISION.Settings.ChatVisibility.All",
      gm: "DICEVISION.Settings.ChatVisibility.GM",
      self: "DICEVISION.Settings.ChatVisibility.Self"
    }
  });

  game.settings.register(MODULE_ID, "rollLabel", {
    name: "DICEVISION.Settings.RollLabel.Name",
    hint: "DICEVISION.Settings.RollLabel.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "DiceVision"
  });
}
