# Lockin Design Source Of Truth

This folder is the only design authority for the Lockin app redesign.

The current canonical Today screen is the newer title-case reference encoded in `LOCKIN_DESIGN_HANDOFF.md`: `Locked In.`, no Today wordmark, Today Work, At a Glance, Daily Progress, bottom split card, and quiet native footer. Older all-screens imagery is useful for the broader product direction, but it does not override that Today specification.

## Authoritative Files

- `LOCKIN_DESIGN_HANDOFF.md`: product feeling, screen specs, interaction intent, copy examples, and implementation guidance.
- `lockin_design_tokens.json`: exact palette, typography, spacing, radii, border widths, and component token values.

## Reference Asset

- `references/lockin-all-screens-reference.png`: uploaded all-screens visual reference from the earlier handoff conversation. It is kept for broader visual alignment and QA, not as a separate source that overrides the handoff or tokens.

## Precedence

1. Use `lockin_design_tokens.json` for exact values.
2. Use `LOCKIN_DESIGN_HANDOFF.md` for screen structure, product intent, behavior, and copy.
3. Use `references/lockin-all-screens-reference.png` only to check whether the implementation visually matches the intended direction outside any newer handoff text.

If these sources conflict in a way that affects implementation, clarify the design source before changing app code.

## Exclusions

The current SwiftUI UI, old generated images, memory summaries, previous app screenshots, and loose chat descriptions are not design sources for the redesign.
