/**
 * Replace mode: fill Foundry's own dice rolls with physical dice.
 *
 * Registers "dicevision" as a Foundry dice fulfillment method. When a roll
 * uses it (every die type in Replace mode, or the die types a user picks in
 * Core > Dice Configuration), Foundry opens its RollResolver dialog and
 * pauses the roll. This module waits on the DiceVision bridge while such a
 * dialog has empty DiceVision slots, and fills them from the dice the
 * camera reads. Designed to cover /roll and system rolls (e.g. dnd5e
 * attacks and damage), including extra dice for explode and reroll.
 *
 * Digital fallback, so a camera problem never blocks a roll: the dialog's
 * Submit button rolls any still-empty slot digitally. Extra dice for
 * explode/reroll come after the first pass, when Submit is disabled; each
 * has its own arrow button that rolls it digitally.
 */

import { matchDice, dropCarriedOver, SUPPORTED_DICE } from "./dice-matching.js";

export const METHOD_ID = "dicevision";
const STATUS_CLASS = "dicevision-status";
const NOTICE_CLASS = "dicevision-status-notice";
const DICEVISION_INPUTS = `label[data-method="${METHOD_ID}"] > input:not(:disabled)`;
/** How long dice from the last roll count as still on the table */
const CARRY_OVER_MS = 2 * 60 * 1000;

/**
 * @param {import("./dicevision-client.js").DiceVisionClient} client
 */
export function registerRollIntercept(client) {
  CONFIG.Dice.fulfillment.methods[METHOD_ID] = {
    label: "DICEVISION.Fulfillment.Label",
    icon: '<i class="fa-solid fa-camera"></i>',
    interactive: true
  };

  /** Open RollResolver dialogs, oldest first. */
  const resolvers = new Set();
  /** @type {WeakMap<object, MutationObserver>} */
  const observers = new WeakMap();
  /** @type {WeakMap<object, string>} Last mismatch notice per dialog */
  const notices = new WeakMap();
  /** Dialogs we've already shown an update-error toast for */
  const failed = new WeakSet();
  /** The dice of the last roll a dialog used, and when */
  let lastRoll = { dice: [], at: 0 };

  /** Report a dialog update error once per dialog; the user can still Submit. */
  const reportFailure = (app, err) => {
    console.error("[DiceVision] Failed to update roll dialog:", err);
    if (failed.has(app)) return;
    failed.add(app);
    ui.notifications.error(game.i18n.format("DICEVISION.Notifications.DialogFailed", { error: err.message }));
  };

  const renderAll = () => {
    for (const app of resolvers) {
      try {
        renderStatus(app, client, notices.get(app));
      } catch (err) {
        reportFailure(app, err);
      }
    }
  };

  /** Update every dialog, then register or release the bridge to match. */
  const refresh = () => {
    for (const app of resolvers) {
      // One broken dialog mustn't stop the others, or the sync below
      try {
        const digital = rollUnsupportedDigitally(app);
        if (digital.length) {
          ui.notifications.info(game.i18n.format("DICEVISION.Fulfillment.RolledDigitally", { dice: summarize(digital) }));
        }
        renderStatus(app, client, notices.get(app));
      } catch (err) {
        reportFailure(app, err);
      }
    }
    client.sync();
  };

  client.addRollConsumer({
    wantsRoll: () => openSlots(resolvers).length > 0,
    consume: (rollData) => {
      try {
        const slots = openSlots(resolvers);
        const needs = slots.map(s => s.denomination);
        const previous = Date.now() - lastRoll.at < CARRY_OVER_MS ? lastRoll.dice : [];
        const { dice, carried } = dropCarriedOver(rollData.dice, previous, needs);
        if (carried.length) console.log("[DiceVision] Still on the table from the last roll, not used:", carried);
        lastRoll = { dice: rollData.dice ?? [], at: Date.now() };

        const { fills, unused } = matchDice(dice, needs);
        const rejected = [];
        for (const { index, value } of fills) {
          const { app, denomination } = slots[index];
          if (!app.registerResult(METHOD_ID, denomination, value)) {
            // Foundry already warns "... was not needed by the resolver"
            console.warn(`[DiceVision] Roll dialog rejected ${denomination} ${value}`);
            rejected.push({ type: denomination, value, reason: "rejected" });
          }
        }

        const nothing = !fills.length && !unused.length && !carried.length;
        const notice = nothing ? game.i18n.localize("DICEVISION.Fulfillment.EmptyRoll")
          : unused.length || rejected.length ? describeUnused([...unused, ...rejected]) : null;
        // Rejected dice already got Foundry's own toast
        if (nothing || unused.length) ui.notifications.warn(nothing ? notice : describeUnused(unused));
        for (const app of new Set(slots.map(s => s.app))) {
          if (notice) notices.set(app, notice);
          else notices.delete(app);
        }
      } finally {
        refresh();
      }
    },
    noDice: () => {
      const notice = game.i18n.localize("DICEVISION.Notifications.NoDice");
      for (const app of new Set(openSlots(resolvers).map(s => s.app))) notices.set(app, notice);
      renderAll();
    }
  });

  Hooks.on("renderRollResolver", (app) => {
    if (!resolvers.has(app)) {
      resolvers.add(app);
      // Explode and reroll add inputs without a re-render
      if (typeof MutationObserver !== "undefined" && app.element) {
        // Only react to new inputs: our own status updates are mutations too
        const observer = new MutationObserver((mutations) => {
          if (mutations.some(m => [...m.addedNodes].some(addsInput))) refresh();
        });
        observer.observe(app.element, { childList: true, subtree: true });
        observers.set(app, observer);
      }
    }
    refresh();
  });

  Hooks.on("closeRollResolver", (app) => {
    resolvers.delete(app);
    observers.get(app)?.disconnect();
    observers.delete(app);
    client.sync();
  });

  // Replace mode makes DiceVision Foundry's default method. Keep it through
  // a reconnect, so a brief drop doesn't quietly turn rolls digital: the
  // dialog says DiceVision isn't connected and Submit rolls digitally. Only
  // an explicit disconnect, an invalid session, giving up on reconnecting,
  // or leaving Replace mode hands rolls back, to whatever method was the
  // default before.
  let previousDefault = null;
  const applyDefaultMethod = (state) => {
    const fulfillment = CONFIG.Dice.fulfillment;
    const intercept = state.mode === "replace" && state.sessionActive;
    if (intercept && fulfillment.defaultMethod !== METHOD_ID) {
      previousDefault = fulfillment.defaultMethod;
      fulfillment.defaultMethod = METHOD_ID;
    } else if (!intercept && fulfillment.defaultMethod === METHOD_ID) {
      fulfillment.defaultMethod = previousDefault ?? "";
      previousDefault = null;
    }
    renderAll();
  };
  Hooks.on("dicevision.stateChanged", applyDefaultMethod);
  applyDefaultMethod(client.getState());
}

/**
 * Whether Core > Dice Configuration sends any die type to DiceVision.
 * @returns {boolean}
 */
export function diceConfigUsesDiceVision() {
  try {
    const setting = foundry.dice.Roll.DICE_CONFIGURATION_SETTING;
    return Object.values(game.settings.get("core", setting) ?? {}).includes(METHOD_ID);
  } catch (err) {
    console.warn("[DiceVision] Couldn't read Core Dice Configuration:", err);
    return false;
  }
}

/** Empty, enabled DiceVision inputs in one dialog that the camera can fill. */
function cameraInputs(app) {
  if (!app.rendered || !app.element) return [];
  return [...app.element.querySelectorAll(DICEVISION_INPUTS)]
    .filter(input => input.value === "" && input.parentElement.dataset.denomination in SUPPORTED_DICE);
}

/**
 * Empty, enabled DiceVision inputs across the open dialogs, oldest first.
 * @returns {{app: object, input: HTMLInputElement, denomination: string}[]}
 */
function openSlots(resolvers) {
  return [...resolvers].flatMap(app => cameraInputs(app).map(input => ({
    app, input, denomination: input.parentElement.dataset.denomination
  })));
}

/** Empty, enabled DiceVision inputs for dice the camera can't read. */
function unreadableInputs(app) {
  if (!app.rendered || !app.element) return [];
  return [...app.element.querySelectorAll(DICEVISION_INPUTS)]
    .filter(input => input.value === "" && !(input.parentElement.dataset.denomination in SUPPORTED_DICE));
}

/**
 * The camera can't read dice like d3, d2 or coins: roll those digitally
 * instead of leaving the dialog waiting for them.
 * @returns {string[]} Denominations rolled digitally
 */
function rollUnsupportedDigitally(app) {
  const rolled = [];
  for (const input of unreadableInputs(app)) {
    const denomination = input.parentElement.dataset.denomination;
    const term = app.fulfillable?.get(input.name)?.term;
    if (!term) {
      console.warn(`[DiceVision] No dice term for ${denomination} input "${input.name}"; leaving it to Submit`);
    } else if (app.registerResult(METHOD_ID, denomination, term.randomFace())) {
      rolled.push(denomination);
    } else {
      console.warn(`[DiceVision] Roll dialog rejected a digital ${denomination}`);
    }
  }
  return rolled;
}

/** Show what the dialog is waiting for at the top of it. */
function renderStatus(app, client, notice) {
  const form = app.element;
  if (!app.rendered || !form) return;
  // Only dialogs with DiceVision dice (not manual entry or other modules)
  if (!form.querySelector(`label[data-method="${METHOD_ID}"]`)) {
    form.querySelector(`.${STATUS_CLASS}`)?.remove();
    form.querySelector(`.${NOTICE_CLASS}`)?.remove();
    return;
  }

  let status = form.querySelector(`.${STATUS_CLASS}`);
  if (!status) {
    status = document.createElement("p");
    status.className = STATUS_CLASS;
    const formula = form.querySelector(".formula");
    if (formula) formula.after(status);
    else form.prepend(status);
  }

  const waiting = cameraInputs(app).map(input => input.parentElement.dataset.denomination);
  // Unreadable dice we couldn't roll digitally (no term): only Submit helps
  const stuck = unreadableInputs(app).map(input => input.parentElement.dataset.denomination);
  // After the first pass (explode, reroll) Submit stays disabled; each extra
  // die has its own arrow button instead
  const extraDice = !!form.querySelector('button[type="submit"]')?.disabled;
  const fallback = extraDice ? "Extra" : "";
  const connected = client.isConnected();
  const text = !connected ? game.i18n.localize(`DICEVISION.Fulfillment.NotConnected${fallback}`)
    : waiting.length ? game.i18n.format(`DICEVISION.Fulfillment.Waiting${fallback}`, { dice: summarize(waiting) })
    : stuck.length ? game.i18n.format(`DICEVISION.Fulfillment.Unreadable${fallback}`, { dice: summarize(stuck) })
    : game.i18n.localize("DICEVISION.Fulfillment.Done");
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle("dicevision-waiting", connected && waiting.length > 0);

  let warning = form.querySelector(`.${NOTICE_CLASS}`);
  // A "roll again" notice makes no sense while DiceVision isn't connected
  if (notice && waiting.length && connected) {
    if (!warning) {
      warning = document.createElement("p");
      warning.className = NOTICE_CLASS;
      status.after(warning);
    }
    if (warning.textContent !== notice) warning.textContent = notice;
  } else {
    warning?.remove();
  }
}

function addsInput(node) {
  return node.nodeName === "INPUT" || !!node.querySelector?.("input");
}

/** ["d20", "d20", "d6"] → "2d20, 1d6" */
export function summarize(denominations) {
  const counts = new Map();
  for (const d of denominations) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts].map(([d, n]) => `${n}${d}`).join(", ");
}

/** A warning naming dice the roll couldn't use. */
export function describeUnused(unused) {
  const describe = reason => unused.filter(d => d.reason === reason).map(d => `${d.type} (${d.value})`).join(", ");
  const messages = {
    "not-needed": "DICEVISION.Fulfillment.NotNeeded",
    "out-of-range": "DICEVISION.Fulfillment.OutOfRange",
    "missing-pair": "DICEVISION.Fulfillment.MissingPair",
    rejected: "DICEVISION.Fulfillment.Rejected"
  };
  return Object.entries(messages)
    .map(([reason, key]) => [describe(reason), key])
    .filter(([dice]) => dice)
    .map(([dice, key]) => game.i18n.format(key, { dice }))
    .join(" ");
}
