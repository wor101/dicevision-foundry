/**
 * Match physical dice from DiceVision against the dice a Foundry roll needs.
 *
 * Pure functions, no Foundry globals, so they are unit-testable. Mirrors the
 * Codex mod's buildForcedDice (match by die type, any order; d10 "0" is 10;
 * a "00" + "0" pair is a d100 of 100), except that a partial match is fine:
 * Foundry's roll dialog fills what matches and keeps waiting for the rest.
 */

/** Die types the camera can read, with their face counts. */
export const SUPPORTED_DICE = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20, d100: 100 };

/**
 * @typedef {object} PhysicalDie
 * @property {string} type    e.g. "d20"
 * @property {number} value   Face value. The dashboard sends numbers: pips as
 *                            their dot count, a d10 "0" and "00" both as 0.
 *                            Faces it can't turn into a number also arrive
 *                            as 0; the classifier only reads numerals and
 *                            pips today, so a d10 0 is taken as a real 0.
 */

/**
 * @typedef {object} UnusedDie
 * @property {string} type
 * @property {number} value
 * @property {"not-needed"|"out-of-range"|"missing-pair"} reason
 *   missing-pair: a d10 left over while a d100 still needs a tens + units pair
 */

/**
 * Assign physical dice to the open slots of a roll.
 * @param {PhysicalDie[]} dice         What the camera read
 * @param {string[]} needs             One denomination per open slot, e.g. ["d20", "d20", "d6"]
 * @returns {{fills: {index: number, value: number}[], unused: UnusedDie[]}}
 *   fills: index into `needs` and the value to enter there
 */
export function matchDice(dice, needs) {
  const pool = (dice ?? []).map(d => ({ type: String(d.type).toLowerCase(), value: Number(d.value) }));
  const open = needs.map((denomination, index) => ({ denomination, index }));
  const fills = [];
  const unused = [];

  const take = (predicate) => {
    const i = pool.findIndex(predicate);
    return i > -1 ? pool.splice(i, 1)[0] : null;
  };
  const fill = (slot, value) => {
    fills.push({ index: slot.index, value });
    open.splice(open.indexOf(slot), 1);
  };

  // d100 slots first, so a percentile pair isn't split up to fill d10 slots.
  // A pair is a tens die (00, 10..90; "00" arrives as 0) plus a units die
  // (0..9). Prefer an unambiguous tens die (10..90) before a 0: a d10's own
  // "0" face arrives as 0, never as 10, so only a percentile die sends 10..90.
  for (const slot of open.filter(s => s.denomination === "d100")) {
    const direct = take(d => d.type === "d100" && inRange(d.value, 100));
    if (direct) {
      fill(slot, direct.value);
      continue;
    }
    const isTens = d => d.type === "d10" && Number.isInteger(d.value) && d.value % 10 === 0 && d.value >= 0 && d.value <= 90;
    const tens = take(d => isTens(d) && d.value >= 10) ?? take(isTens);
    if (!tens) continue;
    const units = take(d => d.type === "d10" && Number.isInteger(d.value) && d.value >= 0 && d.value <= 9);
    if (!units) {
      pool.push(tens);
      continue;
    }
    fill(slot, tens.value + units.value || 100);
  }

  for (const die of pool) {
    const value = die.type === "d10" && die.value === 0 ? 10 : die.value;
    const slot = open.find(s => s.denomination === die.type);
    if (slot && inRange(value, SUPPORTED_DICE[die.type])) {
      fill(slot, value);
    } else if (die.type === "d10" && open.some(s => s.denomination === "d100")) {
      unused.push({ ...die, reason: "missing-pair" });
    } else {
      unused.push({ ...die, reason: slot ? "out-of-range" : "not-needed" });
    }
  }

  return { fills, unused };
}

function inRange(value, faces) {
  return Number.isInteger(value) && value >= 1 && value <= faces;
}
