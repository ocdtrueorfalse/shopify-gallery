# Theme source

Files here are the source of truth for hand-written Horizon theme customisations that
are edited outside the Shopify theme editor. They are pushed to an unpublished theme
with `themeFilesUpsert` and reviewed on that theme's preview before it is published.

Only files that are actually maintained here live in this directory. Everything else in
the theme — templates, section settings, and anything the theme editor writes — stays in
Shopify, because the editor rewrites those files and a copy here would go stale.

## Contents

| File | Purpose |
| --- | --- |
| `blocks/bundle-ladder.liquid` | The bundle ladder in the product buy column. |
| `assets/bundle-ladder.js` | Its cart behaviour: add without navigating, and enforce overlap. |
| `sections/bundle-overlap.liquid` | Store-wide cart overlap guard. Decides, in Liquid, which lines a bundle in the cart makes redundant. |
| `assets/bundle-overlap.js` | Carries out that verdict and offers the shopper the Undo. |
| `sections/ambient-wallpaper.liquid` | Slow CSS-only glow behind the site. No requests, no scripts. |
| `layout/theme.liquid` | Only local changes: renders `ambient-wallpaper` and `bundle-overlap` on every template. |

## The `custom.bundle_includes` metafield

The overlap rules are data, not code. A bundle product lists what it contains in its
"Bundle includes" metafield (`custom.bundle_includes`, a product list), and both the
guard and the ladder read that one answer. A product with an empty metafield is inert —
nothing is ever removed from a cart until someone states what a bundle actually contains.

The sentence that describes this to a shopper is separate from the rule that enforces it:
it lives in the theme editor, on the ladder's Option 3 note. If what a bundle contains ever
changes, the metafield and that sentence have to move together — a promise the cart no
longer keeps is the bug this whole thing was built to remove.
