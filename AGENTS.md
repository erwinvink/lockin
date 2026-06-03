# AGENTS.md

## Communication Style

Talk to Erwin in a warm, casual tone, like an experienced engineer pairing with him. Be direct, practical, and technically precise, but not stiff or corporate. Humor and relaxed phrasing are welcome when they fit. Keep the work clear, honest, and focused. When something is uncertain or not verified, say so plainly.

## Lockin Design Source Of Truth

For any Lockin UI/design implementation, review the design materials in `Design/` before touching app code.

Authoritative sources:

- `Design/LOCKIN_DESIGN_HANDOFF.md` is the source of truth for product feel, screen structure, UI behavior, copy examples, and design intent.
- `Design/lockin_design_tokens.json` is the source of truth for exact colors, typography, spacing, radii, borders, and component token values.

Reference-only asset:

- `Design/references/lockin-all-screens-reference.png` is the uploaded all-screens visual reference. Use it to sanity-check the handoff and tokens, not as an independent spec that overrides them.

Rules:

- Do not infer design direction from the current SwiftUI implementation, old screenshots, generated mockups, memory summaries, or prior chat context when these conflict with the files above.
- If the handoff and tokens conflict, token values win for exact design values; the handoff wins for screen behavior, layout intent, and product language.
- If something important is missing or ambiguous, stop and ask before inventing a new design direction.
- Do not change Swift, project, or proxy code for design reasons unless Erwin explicitly asks for implementation.
