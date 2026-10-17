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
 * A die as readDice returns it.
 * @typedef {object} PhysicalDie
 * @property {string} type       e.g. "d20"; "d?" when the server sent none
 * @property {number} value      The face's number: pips as their dot count, a
 *                               d10 "0" and "00" both 0, -1 when unreadable
 * @property {string} face       The face the server reports: "7", "0", "00",
 *                               "30", "pip_4", "-1" when unreadable. From
 *                               older servers it is String(value), so a "00"
 *                               reads as "0" and pips as "4".
 * @property {boolean} readable  False when the camera couldn't read the die,
 *                               or its value isn't a whole number >= 0
 * @property {boolean} legacy    True when the server sent no face (before
 *                               dice-vision PR #420): "0" may then be a "00"
 */

/**
 * The number a DiceVision face string stands for: "7" -> 7, "00" -> 0,
 * "pip_4" -> 4, "-1" -> -1. null for any other symbol.
 * @param {string} face
 * @returns {number|null}
 */
export function faceNumber(face) {
  const s = String(face ?? "").trim();
  const pips = /^pip_(-?\d+)$/.exec(s);
  if (pips) return Number(pips[1]);
  return /^-?\d+$/.test(s) ? Number(s) : null;
}

/**
 * Read the dice of a DiceVision roll. The server sends each die as
 * {type, value, face, readable} (dice-vision PR #420); older servers sent
 * {type, value} only, so face and readable are worked out from value then.
 * Anything that isn't a die object, and a `readable` other than true (or
 * missing), reads as an unreadable die, so it's reported rather than thrown
 * on or entered. A dice list that isn't an array reads as no dice.
 *
 * Safe to call on its own output: the client reads each roll on arrival, and
 * matchDice, dropCarriedOver and buildRollData read what they're given again.
 * @param {object[]} dice
 * @returns {PhysicalDie[]}
 */
export function readDice(dice) {
  if (!Array.isArray(dice)) return [];
  return dice.map((d) => {
    if (!d || typeof d !== "object") return { type: "d?", value: -1, face: "-1", readable: false, legacy: false };
    const type = typeof d.type === "string" && d.type.trim() ? d.type.trim().toLowerCase() : "d?";
    const legacy = d.legacy === true || (d.legacy === undefined && d.face === undefined);
    const face = String(d.face ?? d.value ?? "-1").trim();
    const value = typeof d.value === "number" ? d.value : faceNumber(face);
    const readable = (d.readable === undefined || d.readable === true) && Number.isInteger(value) && value >= 0;
    return { type, value: readable ? value : -1, face, readable, legacy };
  });
}

/**
 * "2d20, 1d6" from ["d20", "d20", "d6"]
 * @param {string[]} denominations
 */
export function summarize(denominations) {
  const counts = new Map();
  for (const d of denominations) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts].map(([d, n]) => `${n}${d}`).join(", ");
}

/** A d10 showing a percentile tens face: "00" (by face), or 10..90 (by value, so older servers' numbers count too) */
export const isTensFace = d => d.type === "d10" && d.readable && (d.face === "00" || (d.value % 10 === 0 && d.value >= 10 && d.value <= 90));
/** A d10 showing a single digit, "0".."9" */
export const isUnitsFace = d => d.type === "d10" && d.readable && /^\d$/.test(d.face);

/**
 * @typedef {object} UnusedDie
 * @property {string} type
 * @property {number} value
 * @property {string} [face]   Missing on dice the roll dialog rejected
 * @property {"not-needed"|"out-of-range"|"missing-pair"|"unreadable"|"rejected"} reason
 *   missing-pair: a d10 left over while a d100 still needs a tens + units pair;
 *   unreadable: the camera couldn't read a die of a type the roll still
 *   wants, so it fills nothing; rejected: the roll dialog refused the value
 *   (added by roll-intercept.js, not matchDice)
 */

/**
 * Assign physical dice to the open slots of a roll.
 * @param {object[]} dice             What the camera read (see readDice)
 * @param {string[]} needs             One denomination per open slot, e.g. ["d20", "d20", "d6"]
 * @returns {{fills: {index: number, value: number}[], unused: UnusedDie[], ignored: PhysicalDie[]}}
 *   fills: index into `needs` and the value to enter there; ignored:
 *   unreadable dice of a type the roll no longer wants (e.g. the attack's d20
 *   in view during the damage roll), set aside without a warning
 */
export function matchDice(dice, needs) {
  const read = readDice(dice);
  const pool = read.filter(d => d.readable);
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
  // A pair is a tens die ("00", "10".."90") plus a units die ("0".."9").
  // From a server that sent no faces, "00" arrived as 0, so a d10 "0" stands
  // in for it when no tens die is left. With faces it never does: the "00"
  // may be the unreadable die, and "0" + "7" isn't a percentile roll.
  for (const slot of open.filter(s => s.denomination === "d100")) {
    const direct = take(d => d.type === "d100" && inRange(d.value, 100));
    if (direct) {
      fill(slot, direct.value);
      continue;
    }
    const tens = take(isTensFace) ?? take(d => d.legacy && d.type === "d10" && d.face === "0");
    if (!tens) continue;
    const units = take(isUnitsFace);
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

  // Unreadable dice: worth a "roll again" only while the roll still wants
  // that type (a d10 while a d100 is open)
  const ignored = [];
  for (const die of read.filter(d => !d.readable)) {
    const wanted = open.some(s => s.denomination === die.type || (die.type === "d10" && s.denomination === "d100"));
    if (wanted) unused.push({ ...die, reason: "unreadable" });
    else ignored.push(die);
  }

  return { fills, unused, ignored };
}

function inRange(value, faces) {
  return Number.isInteger(value) && value >= 1 && value <= faces;
}

/**
 * Leave out dice still on the table from the previous roll. The camera reads
 * everything in view, so after a partial fill ("roll the missing d20") the
 * die that was already used comes back too, and would fill the empty slot in
 * place of the new one.
 *
 * Only a surplus is dropped: per die type, at most (dice read - dice needed),
 * and only dice whose face matches one from the previous roll (so a "00"
 * isn't taken for a "0" still on the table). A full re-roll that happens to
 * repeat a value still counts. Unreadable dice are never dropped (they're
 * reported instead), but they count toward the surplus, so a readable die
 * from the last roll beside one is still dropped. Carried dice aren't
 * reported as unused, so the attack's d20 left in view doesn't warn during
 * the damage roll.
 *
 * @param {object[]} dice           What the camera read now (see readDice)
 * @param {object[]} previous       What it read last time (empty if none)
 * @param {string[]} needs           One denomination per open slot
 * @returns {{dice: PhysicalDie[], carried: PhysicalDie[]}}
 *   dice: the ones to match; carried: left out as still on the table
 */
export function dropCarriedOver(dice, previous, needs) {
  const current = readDice(dice);
  const seen = readDice(previous).filter(d => d.readable);
  // A d100 slot takes two d10s (tens + units)
  const needed = {};
  for (const n of needs) {
    if (n === "d100") needed.d10 = (needed.d10 ?? 0) + 2;
    else needed[n] = (needed[n] ?? 0) + 1;
  }

  const carried = [];
  for (const type of new Set(current.map(d => d.type))) {
    // A type the roll doesn't need at all is all surplus (e.g. the attack's
    // d20 still in view during the damage roll)
    let surplus = current.filter(d => d.type === type).length - (needed[type] ?? 0);
    for (let i = 0; surplus > 0 && i < current.length; i++) {
      const die = current[i];
      // An unreadable die is never taken as left over: it's reported instead
      if (die.type !== type || !die.readable) continue;
      const match = seen.findIndex(s => s.type === die.type && s.face === die.face);
      if (match < 0) continue;
      seen.splice(match, 1);
      carried.push(...current.splice(i--, 1));
      surplus--;
    }
  }
  return { dice: current, carried };
}
