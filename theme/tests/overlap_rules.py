"""Expected cart behaviour for the overlap guard.

This is a MIRROR of the loops in sections/bundle-overlap.liquid, not the source of them.
Change the Liquid and you must change this too, or it quietly stops testing anything.

It exists because the interesting cases are about what must NOT be removed: an add-on
sitting alongside a bundle has to survive, and the cheapest way to be sure of that is to
state every combination and run them.

    python3 theme/tests/overlap_rules.py
"""

ITB     = 10470998081811   # The Intrusive Thoughts Bundle
LIBRARY = 10470997885203   # The Complete OCD Subtype Library (9 Workbooks)
CHEATS  = 10470999999999   # The ERP Cheat Sheets (id stands in; it has no metafield)

# Exactly what is set in the shop right now: one metafield, on the Library.
BUNDLE_INCLUDES = {LIBRARY: [ITB]}

NAMES = {ITB: "ITB", LIBRARY: "Library", CHEATS: "Cheat Sheets"}


def verdict(cart):
    """cart: list of product ids, one per line. Returns the ids the guard would remove."""
    remove = []
    for item in cart:
        covered_by = None
        for other in cart:
            if other is item:            # `unless other.key == item.key`
                continue
            other_includes_item = item in BUNDLE_INCLUDES.get(other, [])
            item_includes_other = other in BUNDLE_INCLUDES.get(item, [])
            if other_includes_item and not item_includes_other:
                covered_by = other
                break
        if covered_by is not None:
            remove.append(item)

    # The script's own refusal: never act on a verdict that clears the cart.
    if remove and len(remove) >= len(cart):
        return "REFUSED (would empty the cart)"
    return remove


CASES = [
    ([CHEATS, LIBRARY],       [],     "cheat sheets + complete bundle"),
    ([CHEATS, ITB],           [],     "cheat sheets + ITB"),
    ([CHEATS, ITB, LIBRARY],  [ITB],  "cheat sheets + ITB + complete bundle"),
    ([ITB, LIBRARY],          [ITB],  "ITB + complete bundle"),
    ([LIBRARY, ITB],          [ITB],  "same, added the other way round"),
    ([CHEATS],                [],     "cheat sheets alone"),
    ([CHEATS, CHEATS],        [],     "two of the cheat sheets"),
    ([ITB],                   [],     "ITB alone"),
    ([CHEATS, LIBRARY, CHEATS], [],   "complete bundle between two add-ons"),
]

ok = True
for cart, expected, label in CASES:
    got = verdict(list(cart))
    passed = got == expected
    ok &= passed
    shown = got if isinstance(got, str) else [NAMES[p] for p in got]
    print(f"{'PASS' if passed else 'FAIL'}  {label:<38} cart={[NAMES[p] for p in cart]}")
    print(f"      removes: {shown or 'nothing'}")

# The mutual-containment guard, if someone ever mis-fills both metafields.
BUNDLE_INCLUDES[ITB] = [LIBRARY]
mutual = verdict([ITB, LIBRARY])
print(f"{'PASS' if mutual == [] else 'FAIL'}  mutual containment (data error)      removes: {mutual or 'nothing'}")
ok &= mutual == []

print("\nALL PASS" if ok else "\nFAILURES ABOVE")
