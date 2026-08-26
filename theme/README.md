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
