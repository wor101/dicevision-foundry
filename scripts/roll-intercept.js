/**
 * Replace mode: fill Foundry's own dice rolls with physical dice.
 *
 * Registers "dicevision" as a Foundry dice fulfillment method. When a roll
 * uses it (every die type in Replace mode while connected, or the die types
 * a user picks in Core > Dice Configuration), Foundry opens its RollResolver
 * dialog and pauses the roll. This module waits on the DiceVision bridge
 * while such a dialog has empty DiceVision slots, and fills them from the
 * dice the camera reads. Covers /roll and system rolls (e.g. dnd5e attacks
 * and damage), including extra dice for explode and reroll.
 *
 * The dialog's Submit button rolls any still-empty slot digitally, so a
 * camera problem never blocks a roll.
 */

import { matchDice, SUPPORTED_DICE } from "./dice-matching.js";

export const METHOD_ID = "dicevision";
const STATUS_CLASS = "dicevision-status";

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

  const refresh = () => {
    for (const app of resolvers) {
      rollUnsupportedDigitally(app);
      renderStatus(app, client, notices.get(app));
    }
    client.sync();
  };

  client.addRollConsumer({
    wantsRoll: () => openSlots(resolvers).length > 0,
    consume: (rollData) => {
      const slots = openSlots(resolvers);
      const { fills, unused } = matchDice(rollData.dice, slots.map(s => s.denomination));
      for (const { index, value } of fills) {
        const { app, denomination } = slots[index];
        app.registerResult(METHOD_ID, denomination, value);
      }

      const notice = unused.length ? describeUnused(unused) : null;
      if (notice) ui.notifications.warn(notice);
      for (const app of new Set(slots.map(s => s.app))) {
        if (notice) notices.set(app, notice);
        else notices.delete(app);
      }
      refresh();
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

  const applyDefaultMethod = (state) => {
    const fulfillment = CONFIG.Dice.fulfillment;
    const intercept = state.mode === "replace" && state.connected;
    if (intercept) fulfillment.defaultMethod = METHOD_ID;
    else if (fulfillment.defaultMethod === METHOD_ID) fulfillment.defaultMethod = "";
    for (const app of resolvers) renderStatus(app, client, notices.get(app));
  };
  Hooks.on("dicevision.stateChanged", applyDefaultMethod);
  applyDefaultMethod(client.getState());
}

/**
 * Empty, enabled DiceVision inputs across the open dialogs, oldest first.
 * @returns {{app: object, input: HTMLInputElement, denomination: string}[]}
 */
function openSlots(resolvers) {
  const slots = [];
  for (const app of resolvers) {
    if (!app.rendered || !app.element) continue;
    for (const input of app.element.querySelectorAll(`label[data-method="${METHOD_ID}"] > input:not(:disabled)`)) {
      const denomination = input.parentElement.dataset.denomination;
      if (input.value === "" && denomination in SUPPORTED_DICE) slots.push({ app, input, denomination });
    }
  }
  return slots;
}

/**
 * The camera can't read dice like d3, d2 or coins: roll those digitally
 * instead of leaving the dialog waiting for them.
 */
function rollUnsupportedDigitally(app) {
  if (!app.rendered || !app.element) return;
  for (const input of app.element.querySelectorAll(`label[data-method="${METHOD_ID}"] > input:not(:disabled)`)) {
    const denomination = input.parentElement.dataset.denomination;
    if (input.value !== "" || denomination in SUPPORTED_DICE) continue;
    const term = app.fulfillable?.get(input.name)?.term;
    if (term) app.registerResult(METHOD_ID, denomination, term.randomFace());
  }
}

/** Show what the dialog is waiting for at the top of it. */
function renderStatus(app, client, notice) {
  const form = app.element;
  if (!app.rendered || !form) return;
  let status = form.querySelector(`.${STATUS_CLASS}`);
  if (!status) {
    status = document.createElement("p");
    status.className = STATUS_CLASS;
    const formula = form.querySelector(".formula");
    if (formula) formula.after(status);
    else form.prepend(status);
  }

  const waiting = [...form.querySelectorAll(`label[data-method="${METHOD_ID}"] > input:not(:disabled)`)]
    .filter(input => input.value === "")
    .map(input => input.parentElement.dataset.denomination);
  const text = !client.isConnected() ? game.i18n.localize("DICEVISION.Fulfillment.NotConnected")
    : waiting.length ? game.i18n.format("DICEVISION.Fulfillment.Waiting", { dice: summarize(waiting) })
    : game.i18n.localize("DICEVISION.Fulfillment.Done");
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle("dicevision-waiting", client.isConnected() && waiting.length > 0);

  let warning = form.querySelector(`.${STATUS_CLASS}-notice`);
  if (notice && waiting.length) {
    if (!warning) {
      warning = document.createElement("p");
      warning.className = `${STATUS_CLASS}-notice`;
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
  const parts = [];
  const notNeeded = describe("not-needed");
  const outOfRange = describe("out-of-range");
  if (notNeeded) parts.push(game.i18n.format("DICEVISION.Fulfillment.NotNeeded", { dice: notNeeded }));
  if (outOfRange) parts.push(game.i18n.format("DICEVISION.Fulfillment.OutOfRange", { dice: outOfRange }));
  return parts.join(" ");
}
