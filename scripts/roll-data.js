/**
 * Foundry roll data for physical dice, as plain objects (the shape Roll#toJSON
 * produces), so these stay pure and unit-testable without Foundry.
 *
 * Dice filled from the camera carry `options.dicevision = { physical: n }` on
 * their term: the number of results that came from physical dice. Term
 * options are saved with the roll, so the mark reaches every client.
 */

import { SUPPORTED_DICE } from "./dice-matching.js";

/**
 * Build an evaluated Roll's data from what the camera read, for Chat mode.
 *
 * One term per die type in the order first read, joined with "+". A d10 "0"
 * counts as 10, as in Replace mode. A percentile tens die (a d10 reading
 * 10..90) pairs with a units d10 (0..9) into a d100. A "00" arrives as 0, the
 * same as a d10 "0", so a 00 + 0 pair can't be recognised here and posts as
 * two d10s of 10 (Replace mode knows when a d100 is wanted and makes it 100).
 *
 * @param {{type: string, value: number}[]} dice
 * @returns {object|null} Roll data for Roll.fromData, or null when a die
 *   can't be a Foundry die (unknown type, out-of-range value, unpaired tens
 *   die): the caller posts the whole roll as the plain DiceVision card
 */
export function buildRollData(dice) {
  const pool = (dice ?? []).map(d => ({ type: String(d.type).toLowerCase(), value: Number(d.value) }));
  if (!pool.length) return null;

  const isTens = d => d.type === "d10" && d.value % 10 === 0 && d.value >= 10 && d.value <= 90;
  const isUnits = d => d.type === "d10" && Number.isInteger(d.value) && d.value >= 0 && d.value <= 9;

  /** Each die's faces and value, with its read position (a pair: its first die's) */
  const read = [];
  const add = (faces, value, at) => read.push({ faces, value, at });

  // Pair each tens die with a units die first, so a units die isn't used up
  // as a plain d10
  const used = new Set();
  for (const tens of pool.filter(isTens)) {
    const units = pool.find(d => d !== tens && !used.has(d) && !isTens(d) && isUnits(d));
    if (!units) return null;
    used.add(tens).add(units);
    add(100, tens.value + units.value, Math.min(pool.indexOf(tens), pool.indexOf(units)));
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
