/**
 * Cart overlap guard.
 *
 * Keeps the cart from holding a bundle together with something that bundle already
 * contains, no matter which button put it there — the bundle ladder, the main Add to
 * cart, an upsell app, quick-add, or a cart carried over from a previous visit.
 *
 * WHAT THIS FILE DOES NOT DECIDE. It does not know what any bundle contains. It asks
 * `sections/bundle-overlap.liquid` — which reads the `custom.bundle_includes` metafield —
 * and acts only on the pairs that section names. The rule stays readable in one Liquid
 * file, and nothing in the browser can talk this into deleting a line the shop's own data
 * did not flag.
 *
 * WHAT THIS FILE DOES DECIDE: which half of an overlapping pair leaves. The answer is
 * always "whichever one the shopper did not just add". Liquid cannot work that out — a
 * cart holding both products looks identical no matter which order it was built in — so
 * the cart's product list is diffed against the previous check to find the new arrival.
 *
 * That direction matters more than it sounds. The first version always dropped the
 * contained item, which meant a shopper already holding the Complete Library who
 * deliberately chose the smaller Intrusive Thoughts Bundle watched their click do
 * nothing: the bundle was added and removed again before the page repainted, and the
 * cart looked frozen. Now the deliberate choice wins and the Library steps aside.
 *
 * TAKING NO FOR AN ANSWER. A shopper who undoes a removal, or dismisses the question,
 * means it. Those products are remembered for the session and never raised again —
 * without that, every page load would delete the thing they just put back, which is a
 * fight the shopper cannot win and would rightly leave over.
 *
 * The fetch helpers below are copied from bundle-ladder.js rather than shared. The theme's
 * importmap in snippets/scripts.liquid lists every module by name, so a new shared module
 * would not resolve without editing that map — a worse trade than two small duplicates.
 */

import { CartLinesUpdateEvent, StandardEvents } from '@shopify/events';

/** How long the "we removed it" toast stays up. The Undo has to outlive the surprise. */
const TOAST_MS = 10000;

/** Session-scoped record of overlaps the shopper has already refused. */
const KEPT_STORAGE_KEY = 'bundle-overlap:kept';

/** The cart as of the last check, used to spot what has arrived since. */
const CART_STORAGE_KEY = 'bundle-overlap:cart';

/**
 * @param {string} key
 * @returns {any} null when nothing is stored, which is different from an empty list:
 *   "no previous cart" must not be read as "every line is brand new".
 */
function readStore(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch (_) {
    // Private browsing and blocked storage both land here. Forgetting is survivable;
    // throwing on a cart page is not.
    return null;
  }
}

/**
 * @param {string} key
 * @param {any} value
 */
function writeStore(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    // See readStore.
  }
}

/** @returns {Set<string>} Variant ids the shopper insisted on keeping this session. */
function keptVariants() {
  return new Set(readStore(KEPT_STORAGE_KEY) ?? []);
}

/** @param {(string | number)[]} variantIds */
function rememberKept(variantIds) {
  const kept = keptVariants();
  for (const id of variantIds) kept.add(String(id));
  writeStore(KEPT_STORAGE_KEY, [...kept]);
}

/** @returns {string[]} */
function cartSectionIds() {
  const ids = new Set();

  for (const el of document.querySelectorAll('cart-items-component')) {
    const id = /** @type {HTMLElement} */ (el).dataset.sectionId;
    if (id) ids.add(id);
  }

  return [...ids];
}

/**
 * @param {string} url
 * @param {object} body
 * @returns {Promise<any>}
 */
async function postJSON(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });

  const payload = await response.json();

  if (!response.ok) throw new Error(payload?.description || payload?.message || `Cart request failed (${response.status})`);

  return payload;
}

/**
 * Tells the rest of the theme the cart moved. Always 'update', never 'add': a removal
 * must not be the thing that throws the cart drawer open over the page.
 *
 * @param {Element} target
 * @param {{sections: Record<string, string> | undefined, itemCount: number | undefined}} options
 */
function announceCartUpdate(target, { sections, itemCount }) {
  const resolved = {
    detail: { sections, itemCount, source: 'bundle-overlap', didError: false },
  };

  try {
    const deferred = CartLinesUpdateEvent.createPromise();

    target.dispatchEvent(
      new CartLinesUpdateEvent({ action: 'update', context: 'cart', lines: [], promise: deferred.promise })
    );

    deferred.resolve(resolved);
  } catch (error) {
    console.warn('[bundle-overlap] Falling back to a plain cart event:', error);

    const event = /** @type {any} */ (new Event(StandardEvents.cartLinesUpdate, { bubbles: true }));
    event.action = 'update';
    event.promise = Promise.resolve(resolved);
    target.dispatchEvent(event);
  }
}

/**
 * @typedef {object} OverlapLine
 * @property {string} key
 * @property {number} variant_id
 * @property {number} quantity
 * @property {number} product_id
 * @property {string} title
 *
 * @typedef {object} OverlapPair
 * @property {OverlapLine} contained
 * @property {OverlapLine} container
 *
 * @typedef {object} Verdict
 * @property {number} lines
 * @property {(string | number)[]} products
 * @property {OverlapPair[]} pairs
 *
 * @typedef {OverlapLine & {survivor: OverlapLine, swapped: boolean}} Removal
 */

const EMPTY_VERDICT = '{"lines":0,"products":[],"pairs":[]}';

class BundleOverlap extends HTMLElement {
  /** @type {AbortController | null} */
  #listeners = null;

  /** True while this element is the one mutating the cart, so it ignores its own event. */
  #applying = false;

  /** True while a verdict is being fetched; a change arriving mid-flight sets #stale. */
  #checking = false;
  #stale = false;

  /** @type {Removal[]} */
  #offered = [];

  connectedCallback() {
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;

    document.addEventListener(StandardEvents.cartLinesUpdate, this.#onCartUpdate, { signal });
    this.addEventListener('click', this.#onClick, { signal });

    // The section rendered a verdict for the cart as it stands, so the first check costs
    // no request. This is the one that catches a cart made redundant somewhere else.
    this.#act(this.#inlineVerdict()).catch((error) => console.error('[bundle-overlap]', error));
  }

  disconnectedCallback() {
    this.#listeners?.abort();
    this.#listeners = null;
  }

  get #routes() {
    return {
      cart: this.dataset.cartUrl || '/cart',
      add: this.dataset.addUrl || '/cart/add',
      update: this.dataset.updateUrl || '/cart/update',
    };
  }

  get #asks() {
    return this.dataset.mode === 'ask';
  }

  /** @returns {Verdict} */
  #inlineVerdict() {
    const node = document.querySelector('[data-blo-verdict]');

    try {
      return JSON.parse(node?.textContent || EMPTY_VERDICT);
    } catch (_) {
      return { lines: 0, products: [], pairs: [] };
    }
  }

  /** @param {any} event */
  #onCartUpdate = (event) => {
    if (this.#applying) return;

    // The cart is only actually changed once the originating request settles; checking
    // before that reads the previous cart and reaches the wrong verdict.
    const settled = event?.promise ? Promise.resolve(event.promise).catch(() => null) : Promise.resolve(null);

    settled.then(() => this.#check()).catch((error) => console.error('[bundle-overlap]', error));
  };

  /**
   * @param {URL} url
   * @returns {Promise<Verdict | null>} null when the response carried no verdict, which
   *   is the caller's signal to try another URL.
   */
  async #verdictFrom(url) {
    const response = await fetch(url, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Overlap check failed (${response.status})`);

    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
    const node = parsed.querySelector('[data-blo-verdict]');
    if (!node) return null;

    try {
      return JSON.parse(node.textContent || '');
    } catch (_) {
      return null;
    }
  }

  async #check() {
    if (this.#checking) {
      this.#stale = true;
      return;
    }

    this.#checking = true;

    try {
      const sectionUrl = new URL(window.location.pathname, window.location.origin);
      sectionUrl.searchParams.set('section_id', this.dataset.sectionId || 'bundle-overlap');

      /** @type {Verdict | null} */
      let verdict = null;

      try {
        verdict = await this.#verdictFrom(sectionUrl);
      } catch (error) {
        console.warn('[bundle-overlap] Section render unavailable, falling back:', error);
      }

      // The guard renders from the layout on every template, so the verdict is in the
      // full document too. Costs a page-sized response, and only where the cheap
      // section-only render did not answer.
      if (!verdict) verdict = await this.#verdictFrom(new URL(window.location.pathname, window.location.origin));

      if (verdict) await this.#act(verdict);
    } finally {
      this.#checking = false;

      if (this.#stale) {
        this.#stale = false;
        this.#check().catch((error) => console.error('[bundle-overlap]', error));
      }
    }
  }

  /**
   * Works out which half of each overlapping pair has to go, then does it.
   *
   * @param {Verdict} verdict
   */
  async #act(verdict) {
    if (this.hasAttribute('data-design-mode')) return;

    const products = (verdict.products || []).map(String);
    const previous = /** @type {string[] | null} */ (readStore(CART_STORAGE_KEY));
    writeStore(CART_STORAGE_KEY, products);

    const pairs = verdict.pairs || [];
    if (!pairs.length) return;

    // With no previous snapshot there is no "just added" — this is a cart that was
    // already redundant when the page loaded, so the bundle keeps its place.
    const justAdded = new Set(previous ? products.filter((id) => !previous.includes(id)) : []);
    const kept = keptVariants();

    /** @type {Map<string, Removal>} */
    const removals = new Map();

    for (const pair of pairs) {
      const { contained, container } = pair || {};
      if (!contained?.key || !container?.key) continue;

      // The shopper's most recent deliberate choice is the one that survives. If both
      // arrived together there is no choice to honour, and the bundle wins.
      const choseContained =
        justAdded.has(String(contained.product_id)) && !justAdded.has(String(container.product_id));

      const victim = choseContained ? container : contained;
      const survivor = choseContained ? contained : container;

      if (kept.has(String(victim.variant_id))) continue;

      removals.set(victim.key, { ...victim, survivor, swapped: choseContained });
    }

    const lines = [...removals.values()];
    if (!lines.length) return;

    // A verdict that clears the cart is a data error upstream, not an instruction.
    if (verdict.lines && lines.length >= verdict.lines) {
      console.warn('[bundle-overlap] Refusing a verdict that would empty the cart.');
      return;
    }

    if (this.#asks) {
      this.#offered = lines;
      this.#showToast(this.#message(this.dataset.askMessage, lines), {
        action: this.dataset.removeLabel || 'Remove it',
        sticky: true,
      });
      return;
    }

    await this.#remove(lines);
  }

  /** @param {Removal[]} lines */
  async #remove(lines) {
    const sections = cartSectionIds();
    const sectionsPayload = sections.length
      ? { sections: sections.join(','), sections_url: window.location.pathname }
      : {};

    /** @type {Record<string, number>} */
    const updates = {};
    for (const line of lines) updates[line.key] = 0;

    const updated = await postJSON(`${this.#routes.update}.js`, { updates, ...sectionsPayload });

    if (Array.isArray(updated.items)) {
      writeStore(CART_STORAGE_KEY, updated.items.map((/** @type {any} */ i) => String(i.product_id)));
    }

    this.#applying = true;
    announceCartUpdate(this, {
      sections: sections.length ? updated.sections : undefined,
      itemCount: updated.item_count,
    });
    // Cleared on a macrotask so the listeners' promise callbacks, which are microtasks,
    // have all run against the flag before it drops.
    setTimeout(() => {
      this.#applying = false;
    }, 0);

    this.#offered = lines;

    const swapped = lines.some((line) => line.swapped);
    const template = swapped ? this.dataset.swappedMessage : this.dataset.removedMessage;

    this.#showToast(this.#message(template, lines), {
      action: this.dataset.undoLabel || 'Undo',
      sticky: false,
    });
  }

  /**
   * Puts back what was taken, and records that this shopper wants it, so neither this
   * page load nor any later one raises it again.
   */
  async #undo() {
    const lines = this.#offered;
    if (!lines.length) return;

    rememberKept(lines.map((line) => line.variant_id));

    const sections = cartSectionIds();
    const sectionsPayload = sections.length
      ? { sections: sections.join(','), sections_url: window.location.pathname }
      : {};

    const updated = await postJSON(`${this.#routes.add}.js`, {
      items: lines.map(({ variant_id: id, quantity }) => ({ id, quantity })),
      ...sectionsPayload,
    });

    this.#applying = true;
    announceCartUpdate(this, {
      sections: sections.length ? updated.sections : undefined,
      itemCount: undefined,
    });
    setTimeout(() => {
      this.#applying = false;
    }, 0);

    this.#offered = [];
    this.#hideToast();
  }

  /** @param {Event} event */
  #onClick = (event) => {
    const target = /** @type {HTMLElement} */ (event.target);

    if (target?.closest?.('[data-blo-dismiss]')) {
      event.preventDefault();

      // Dismissing the question is an answer: keep both, and stop asking.
      if (this.#asks) rememberKept(this.#offered.map((line) => line.variant_id));

      this.#offered = [];
      this.#hideToast();
      return;
    }

    if (!target?.closest?.('[data-blo-action]')) return;

    event.preventDefault();

    const lines = this.#offered;
    const run = this.#asks ? this.#remove(lines).then(() => this.#hideToast()) : this.#undo();

    run.catch((error) => {
      console.error('[bundle-overlap]', error);
      this.#hideToast();
    });
  };

  /**
   * @param {string | undefined} template
   * @param {Removal[]} lines
   * @returns {string}
   */
  #message(template, lines) {
    const titles = lines.map((line) => line.title);
    const list =
      titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;

    // Real carts hold one overlap at a time; if several ever collide, the survivor named
    // is the first one's, and every removed title is still listed.
    const survivor = lines[0]?.survivor?.title || 'a bundle in your cart';

    return (template || '[items] came out of your cart — [bundle] already includes it.')
      .replace('[items]', list)
      .replace('[bundle]', survivor)
      .replace('[kept]', survivor);
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #toastTimer;

  /**
   * @param {string} message
   * @param {{action: string, sticky: boolean}} options
   */
  #showToast(message, { action, sticky }) {
    const toast = this.querySelector('[data-blo-toast]');
    const text = this.querySelector('[data-blo-text]');
    const button = this.querySelector('[data-blo-action]');

    if (!(toast instanceof HTMLElement) || !(text instanceof HTMLElement)) return;

    text.textContent = message;

    if (button instanceof HTMLElement) {
      button.textContent = action;
      button.hidden = false;
    }

    toast.hidden = false;
    // Top layer, so an open cart drawer — a modal <dialog> — cannot paint over it.
    // Throws if it is somehow already open, which is not worth losing the toast over.
    try {
      /** @type {any} */ (toast).showPopover?.();
    } catch (_) {
      // Already showing; nothing to do.
    }

    clearTimeout(this.#toastTimer);
    if (!sticky) this.#toastTimer = setTimeout(() => this.#hideToast(), TOAST_MS);
  }

  #hideToast() {
    const toast = this.querySelector('[data-blo-toast]');

    if (toast instanceof HTMLElement) {
      try {
        /** @type {any} */ (toast).hidePopover?.();
      } catch (_) {
        // Already hidden.
      }
      toast.hidden = true;
    }

    clearTimeout(this.#toastTimer);
  }
}

if (!customElements.get('bundle-overlap')) {
  customElements.define('bundle-overlap', BundleOverlap);
}
