/**
 * Foundry roll data for physical dice, as plain objects (the shape Roll#toJSON
 * produces), so these stay pure and unit-testable without Foundry.
 *
 * Dice filled from the camera carry `options.dicevision = { physical: n }` on
 * their term: the number of results that came from physical dice. Term
 * options are saved with the roll, so the mark reaches every client.
 */

import { SUPPORTED_DICE, readDice, isTensFace, isUnitsFace } from "./dice-matching.js";

/**
 * Build an evaluated Roll's data from what the camera read, for Chat mode.
 *
 * One term per die type in the order first read, joined with "+". A d10 "0"
 * counts as 10, as in Replace mode. A percentile tens die (a d10 showing
 * "00" or "10".."90") pairs with a units d10 ("0".."9") into a d100, so
 * "00" + "0" is 100. A tens die left without a partner: "10" and "00" are
 * read as a plain d10's 10 (a d10 printed 1-10 shows "10"), others make the
 * whole roll fall back. A pair the camera can't tell apart from a percentile
 * roll ("10" + "4" from a 1-10 d10 and a 0-9 d10) posts as a d100; Replace
 * mode knows what the roll wants. Telling "00" from "0" needs face strings:
 * from a server without them a "00" reads as "0", so 00 + 0 posts as two
 * d10s (unlike Replace mode, there's no "0"-for-"00" fallback here).
 *
 * @param {object[]} dice  What the camera read (see readDice)
 * @returns {object|null} Roll data for Roll.fromData, or null when a die
 *   can't be a Foundry die (unknown type, out-of-range value, a tens die
 *   from 20 to 90 with no units die, or an unreadable die, though the client
 *   doesn't post those at all): the caller posts the whole roll as the plain
 *   DiceVision card
 */
export function buildRollData(dice) {
  const pool = readDice(dice);
  if (!pool.length || pool.some(d => !d.readable)) return null;

  /** Each die's faces and value, with its read position (a pair: its first die's) */
  const read = [];
  const add = (faces, value, at) => read.push({ faces, value, at });

  // Pair each tens die with a units die first, so a units die isn't used up
  // as a plain d10. Tens dice that can also be a plain d10 ("10", "00") pair last.
  const used = new Set();
  const plainToo = d => d.face === "10" || d.face === "00";
  const tensDice = pool.filter(isTensFace).sort((a, b) => plainToo(a) - plainToo(b));
  for (const tens of tensDice) {
    const units = pool.find(d => d !== tens && !used.has(d) && !isTensFace(d) && isUnitsFace(d));
    if (!units) {
      if (plainToo(tens)) continue;
      return null;
    }
    used.add(tens).add(units);
    add(100, tens.value + units.value || 100, Math.min(pool.indexOf(tens), pool.indexOf(units)));
  }

  for (const [at, die] of pool.entries()) {
    if (used.has(die)) continue;
    const faces = SUPPORTED_DICE[die.type];
    const value = die.type === "d10" && die.value === 0 ? 10 : die.value;
    if (!faces || !Number.isInteger(value) || value < 1 || value > faces) return null;
    add(faces, value, at);
  }

  // Groups and results in the order read
  const groups = new Map();
  for (const { faces, value } of read.sort((a, b) => a.at - b.at)) {
    if (!groups.has(faces)) groups.set(faces, { results: [] });
    groups.get(faces).results.push(value);
  }
  const order = [...groups];
  const terms = [];
  let total = 0;
  for (const [faces, { results }] of order) {
    if (terms.length) terms.push({ class: "OperatorTerm", options: {}, evaluated: true, operator: "+" });
    terms.push({
      class: "Die",
      options: { dicevision: { physical: results.length } },
      evaluated: true,
      number: results.length,
      faces,
      modifiers: [],
      results: results.map(result => ({ result, active: true }))
    });
    total += results.reduce((sum, r) => sum + r, 0);
  }
  const formula = order.map(([faces, { results }]) => `${results.length}d${faces}`).join(" + ");
  return { class: "Roll", options: {}, dice: [], formula, terms, total, evaluated: true };
}

/**
 * Take the DiceVision fulfillment method off saved roll data.
 *
 * Dice So Nice! skips animating a roll when every die used an interactive
 * method ("Disabled for manually entered rolls", on by default), which
 * DiceVision has to be for Foundry to open its roll dialog. Without the
 * method, Dice So Nice treats the dice like any other and animates them, on
 * every client. The `options.dicevision` mark still says they were physical.
 *
 * @param {(string|object)[]} rolls  A ChatMessage's source rolls (JSON strings or data)
 * @param {string} method            The method to remove ("dicevision")
 * @returns {{rolls: object[], changed: boolean, physical: boolean}}
 *   rolls: the edited data; physical: whether any stripped term is marked physical
 */
export function stripMethod(rolls, method) {
  let changed = false;
  let physical = false;
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (node.method === method) {
      delete node.method;
      changed = true;
      if (node.options?.dicevision?.physical > 0) physical = true;
    }
    Object.values(node).forEach(visit);
  };
  const parsed = (rolls ?? []).map(r => (typeof r === "string" ? JSON.parse(r) : structuredClone(r)));
  visit(parsed);
  return { rolls: parsed, changed, physical };
}
