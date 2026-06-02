# Design Preferences

> **Shared system first.** The universal WMPC design system — token
> vocabulary, ConfirmModal / row-indicator / focus conventions, the Lucide
> icon system, logo & asset conventions — lives in
> [`../../wmpc-meta/design-system/DESIGN_SYSTEM.md`](../../wmpc-meta/design-system/DESIGN_SYSTEM.md),
> with tokens in
> [`../../wmpc-meta/design-system/tokens.css`](../../wmpc-meta/design-system/tokens.css).
> session-manager's copy of the tokens is
> [`web/src/tokens.css`](../web/src/tokens.css). **Reference `var(--token)`,
> never raw hex.** This file holds only what's specific to session-manager.

When a rule here contradicts an ad-hoc styling choice in code, the code is
wrong — bring it back in line. Date entries when you add new ones.

---

## session-manager specifics

- **Tokens, no overrides.** session-manager's primary (`#1a73e8`) and
  success (`#137333`) already match the canonical defaults, so
  [`web/src/tokens.css`](../web/src/tokens.css) carries the standard values
  as-is. Restyle by changing values there.
- **100% inline, no base stylesheet yet.** Unlike the other web apps,
  session-manager has no `index.css` — there's no global box-sizing /
  margin reset, and `tokens.css` is the only stylesheet. New/edited inline
  styles should pull colors from `var(--token)`.
  - *Recommended follow-up:* add a minimal `web/src/index.css` (box-sizing
    reset, token-based body bg/text, mobile overflow guards) to match
    rating-hub / tournament-manager. Deferred here because it's a layout
    change that needs the full app (Express server + web) running to verify.
- **StatusBadge palette is domain-specific.**
  [`components/StatusBadge.tsx`](../web/src/components/StatusBadge.tsx) maps
  each pipeline state (scheduled / recording / split / complete / failed /
  imported …) to a paired bg+text color in a Material-style scheme. This is
  a status taxonomy, not the shared semantic palette, so it intentionally
  does **not** consume the tokens — keep it self-contained.
