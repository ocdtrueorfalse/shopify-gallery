"""Expected cart behaviour for the overlap guard.

This is a MIRROR of two things, not the source of either:
  * the pair-finding loops in sections/bundle-overlap.liquid, and
  * the "which half leaves" decision in assets/bundle-overlap.js.
Change either and you must change this too, or it quietly stops testing anything.

It exists because the interesting cases are the ones that must NOT happen: an add-on
sitting alongside a bundle has to survive, and a shopper who deliberately picks the
smaller product must not have their click silently undone.

    python3 theme/tests/overlap_rules.py
"""

ITB = 10470998081811  # The Intrusive Thoughts Bundle
LIBRARY = 10470997885203  # The Complete OCD Subtype Library (9 Workbooks)
CHEATS = 10470999999999  # The ERP Cheat Sheets (id stands in; it has no metafield)

# Exactly what is set in the shop right now: one metafield, on the Library.
BUNDLE_INCLUDES = {LIBRARY: [ITB]}

NAMES = {ITB: "ITB", LIBRARY: "Library", CHEATS: "Cheat Sheets"}


def find_pairs(cart):
    """Mirror of the Liquid: emit (contained, container) for every overlap."""
    pairs = []
    for item in cart:
        for other in cart:
            if other is item:
                continue
            other_includes_item = item in BUNDLE_INCLUDES.get(other, [])
            item_includes_other = other in BUNDLE_INCLUDES.get(item, [])
            if other_includes_item and not item_includes_other:
                pairs.append((item, other))
                break
    return pairs


def verdict(cart, previous=None):
    """Mirror of the JS: pick the victim of each pair, then apply the safety refusals."""
    pairs = find_pairs(cart)
    if not pairs:
        return []

    # No previous snapshot means nothing is "just added" — a cart that was already
    # redundant on arrival gets the default treatment.
    just_added = set(p for p in cart if p not in previous) if previous is not None else set()

    removals = []
    for contained, container in pairs:
        chose_contained = contained in just_added and container not in just_added
        victim = container if chose_contained else contained
        if victim not in removals:
            removals.append(victim)

    if removals and len(removals) >= len(cart):
        return "REFUSED (would empty the cart)"
    return removals


CASES = [
    # (previous cart, current cart, expected removals, label)
    (None, [CHEATS, LIBRARY], [], "cheat sheets + complete bundle"),
    (None, [CHEATS, ITB], [], "cheat sheets + ITB"),
    (None, [CHEATS], [], "cheat sheets alone"),
    (None, [ITB], [], "ITB alone"),
    (None, [CHEATS, CHEATS], [], "two of the cheat sheets"),
    (None, [ITB, LIBRARY], [ITB], "already redundant on arrival — bundle wins"),

    # Direction A: shopper adds the big bundle on top of the small one.
    ([ITB], [ITB, LIBRARY], [ITB], "adds Library while holding ITB"),
    ([ITB, CHEATS], [ITB, CHEATS, LIBRARY], [ITB], "same, with an add-on that must survive"),

    # Direction B: the bug. Shopper already holds the Library and deliberately picks ITB.
    ([LIBRARY], [LIBRARY, ITB], [LIBRARY], "adds ITB while holding Library"),
    ([LIBRARY, CHEATS], [LIBRARY, CHEATS, ITB], [LIBRARY], "same, add-on must survive"),

    # No deliberate choice to honour when both land together.
    ([], [ITB, LIBRARY], [ITB], "both added in one go — bundle wins"),

    # An unrelated add must not disturb an overlap the shopper already settled.
    ([LIBRARY, ITB], [LIBRARY, ITB, CHEATS], [ITB], "unrelated add, pre-existing overlap"),
]

ok = True
for previous, cart, expected, label in CASES:
    got = verdict(list(cart), previous)
    passed = got == expected
    ok &= passed
    shown = got if isinstance(got, str) else [NAMES[p] for p in got]
    before = "—" if previous is None else [NAMES[p] for p in previous]
    print(f"{'PASS' if passed else 'FAIL'}  {label}")
    print(f"      had {before} → now {[NAMES[p] for p in cart]} → removes {shown or 'nothing'}")

# Mutual containment, if someone ever mis-fills both metafields.
BUNDLE_INCLUDES[ITB] = [LIBRARY]
mutual = verdict([ITB, LIBRARY], [ITB])
ok &= mutual == []
print(f"{'PASS' if mutual == [] else 'FAIL'}  mutual containment (data error) → removes {mutual or 'nothing'}")

print("\nALL PASS" if ok else "\nFAILURES ABOVE")
