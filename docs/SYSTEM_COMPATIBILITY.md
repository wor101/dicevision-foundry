# System Compatibility

Replace mode hooks Foundry core's dice fulfillment (the roll dialog that
Manual Input uses), not any one game system. A system works if it rolls
through core `Roll` evaluation with standard dice. See "What can break" for
the ways a system can get around it.

Status: ✅ verified · 🟡 expected to work, not tested · ⚠️ partial · ❌ not supported

## Game systems

| System | Version | Foundry | Status | What to check | Notes |
|---|---|---|---|---|---|
| D&D 5e (`dnd5e`) | 6.0.6 | v14 | ✅ | `/roll`, advantage, attack → damage from the item card | Advantage is written `2d20adv`. Verified live and in `scripts-dev/e2e/replace.mjs` |
| Shadowdark | 4.0.6 | v14 | ✅ | Sheet attack and check rolls; Chat-mode cards | Replace mode tested by hand on the Forge. Chat-mode cards before v0.3.2 showed only the formula: they were core `Roll` cards, and Shadowdark's styling hid their total. Now they use Shadowdark's `RollSD` (checked locally) |
| Pathfinder 2e (`pf2e`) | | | 🟡 | Strike, damage, saves, Fortune/Misfortune (2d20kh/kl) | |
| Savage Worlds (`swade`) | | | 🟡 | Trait roll with Wild Die, aces (exploding) | Explosions add inputs: check the dialog asks for each extra die |
| Pathfinder 1e (`pf1`) | | | 🟡 | Attack, damage, saves | |
| Call of Cthulhu 7e (`CoC7`) | | | ⚠️ | Skill roll with bonus / penalty dice | Plain d100 pairs work; extra tens dice may not match how the system expects them |
| Cypher System | | | 🟡 | d20 task roll | |
| Powered by the Apocalypse systems | | | 🟡 | 2d6 move | |
| Blades in the Dark | | | 🟡 | d6 pool, 0-dice roll (2d6kl) | |
| Year Zero Engine (Alien, Forbidden Lands, …) | | | ❌ | Base/skill/gear pools | Symbol dice can't be read. Expect them rolled digitally with a "rolled digitally" notice |
| Genesys / Star Wars FFG | | | ❌ | Narrative dice | Symbol dice, same as above |
| Systems using Fate dice (`dF`) | | | ❌ | `/roll 4dF` | `dF` isn't a camera-readable die; rolled digitally |

## Modules

| Module | Version | Status | Notes |
|---|---|---|---|
| Dice So Nice! | 6.4.4 | 🟡 | Supported from the next release (v0.3.0): Replace-mode rolls and Chat-mode roll cards (not the fallback card) animate, landing on the physical faces (local e2e: `scripts-dev/e2e/dsn.mjs`). Needs a live multi-player check. Before v0.3.0, Replace-mode rolls only animated with "Disabled for manually entered rolls" off, and Chat-mode cards never did |

## What can break

- **Custom dice terms** with faces other than d4–d20 or d100 (symbols, `dF`) are rolled digitally.
- **Rolls that don't open the dialog**: a system or setting that evaluates without interactive fulfillment (blind `/roll`, `allowInteractive: false`, quick or automatic rolls) stays digital.
- **Systems with their own RNG** (not core `Roll`) have nothing to intercept.
- **Foundry before v12** has no fulfillment API. Only v14 has been tested.

## How to check a system

1. Install it in a local test world (see CLAUDE.md, Local End-to-End Testing) with Replace mode on.
2. Run the rolls in "What to check" from a character sheet, using real dice or `scripts-dev/fake-dashboard.mjs --dice`.
3. Record the system and Foundry versions, the status, and anything odd in the table.
