/**
 * Bundle ladder — cart behaviour.
 *
 * WHY THIS EXISTS. The ladder's buttons were plain `<form method="post" action="/cart/add">`
 * submissions. A native submit navigates: the shopper is thrown off the product page and
 * lands in the cart, which is the one place they cannot keep reading about the thing they
 * were about to buy. The ladder sits directly above the upsell app, so the navigation was
 * killing the very cross-sell the ladder was built to feed.
 *
 * This upgrades those forms to fetch-based adds and keeps the shopper where they are.
 *
 * THE SECOND JOB IS HONESTY. Option 3 tells people the library overlaps the bundle they
 * are looking at. Until now the cart happily held both, so the sentence was decoration.
 * A row can now declare, via `data-replaces`, the products it supersedes; those lines come
 * out of the cart the moment it is added, and the shopper is told what left and given an
 * Undo. Removing something from a cart without saying so is the kind of trick this store
 * does not do — hence the notice and the Undo, not a silent splice.
 *
 * PROGRESSIVE ENHANCEMENT IS THE SAFETY NET. The markup is still a real, working form.
 * If this module fails to load or its imports go missing, no submit listener is attached
 * and the browser posts the form the old way: worse UX, but a shopper can still buy. Once
 * the listener is attached a failed add is reported in the row instead, because navigating
 * to the cart at that point would throw away whatever is still queued behind it.
 */

import { CartLinesUpdateEvent, StandardEvents } from '@shopify/events';

/** How long the button sits on "Added" before returning to its label. */
const ADDED_LABEL_MS = 2500;

/**
 * The cart sections that need re-rendering after a mutation. Asking the live DOM rather
 * than hard-coding 'cart-drawer-section' means the cart page, the drawer, or both at once
 * are all handled — and a theme that renders neither simply gets an empty list.
 *
 * @returns {string[]}
 */
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

  // The Ajax API answers 4xx with a JSON body whose `description` is written for shoppers
  // ("You can only add 1 of this item"), so prefer it over the HTTP status text.
  if (!response.ok) throw new Error(payload?.description || payload?.message || `Cart request failed (${response.status})`);

  return payload;
}

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function getJSON(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });

  if (!response.ok) throw new Error(`Cart request failed (${response.status})`);

  return response.json();
}

/**
 * Tells the rest of the theme the cart moved.
 *
 * `action` is load-bearing: `cart-drawer-component` auto-opens on `'add'` and ignores
 * everything else, so 'update' is how this block adds to the cart without yanking the
 * drawer open over the page the shopper is reading. That is the whole point of the
 * "Stay on the page" mode — see the `after_add` setting in the block schema.
 *
 * @param {Element} target - The element the event is dispatched from; it must be in the document.
 * @param {object} options
 * @param {'add' | 'update'} options.action
 * @param {Record<string, string> | undefined} options.sections - Section HTML from the Ajax response.
 * @param {number} options.itemCount
 */
function announceCartUpdate(target, { action, sections, itemCount }) {
  const resolved = {
    detail: { sections, itemCount, source: 'bundle-ladder', didError: false },
  };

  try {
    const deferred = CartLinesUpdateEvent.createPromise();

    target.dispatchEvent(
      new CartLinesUpdateEvent({ action, context: 'product', lines: [], promise: deferred.promise })
    );

    deferred.resolve(resolved);
  } catch (error) {
    // The event class comes from a Shopify-hosted module whose constructor signature is
    // outside this theme's control. Every listener in the theme reads only `.action` and
    // `.promise`, so a hand-built event with those two properties keeps the cart icon and
    // the drawer in sync even if that signature moves under us.
    console.warn('[bundle-ladder] Falling back to a plain cart event:', error);

    const event = /** @type {any} */ (new Event(StandardEvents.cartLinesUpdate, { bubbles: true }));
    event.action = action;
    event.promise = Promise.resolve(resolved);
    target.dispatchEvent(event);
  }
}

/**
 * A single ladder. Owns every row's form inside it.
 *
 * Plain `HTMLElement` rather than the theme's `Component` base class: this needs nothing
 * from it, and staying off it means one less import that can strand the enhancement.
 */
class BundleLadder extends HTMLElement {
  /** @type {AbortController | null} */
  #listeners = null;

  /**
   * Cart mutations run one at a time, because the reconcile step reads the cart and then
   * writes it and overlapping runs would race each other.
   *
   * They QUEUE rather than drop. Adding the cheat sheets and then the complete bundle a
   * moment later is an ordinary thing to want, and the first version of this ignored the
   * second click outright while the first add was in flight — no error, no feedback, the
   * shopper walks to checkout believing they bought something they did not.
   *
   * @type {Promise<unknown>}
   */
  #queue = Promise.resolve();

  /**
   * @param {() => Promise<void>} task
   * @returns {Promise<void>} Settles with this task, not with whatever ran before it.
   */
  #enqueue(task) {
    // Both arms, so one failed add does not cancel everything queued behind it.
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});

    return run;
  }

  connectedCallback() {
    this.#listeners = new AbortController();
    this.addEventListener('submit', this.#onSubmit, { signal: this.#listeners.signal });
    this.addEventListener('click', this.#onClick, { signal: this.#listeners.signal });
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

  /** @param {Event} event */
  #onSubmit = (event) => {
    const form = /** @type {HTMLElement} */ (event.target)?.closest?.('[data-blb-form]');
    if (!(form instanceof HTMLFormElement)) return;

    event.preventDefault();

    const button = form.querySelector('button[type="submit"]');
    if (button instanceof HTMLButtonElement && button.disabled) return;

    // The button changes on the click, not when the queue reaches this task, so a second
    // row clicked during a slow first add visibly registers straight away.
    const restore = this.#showPending(button);

    this.#enqueue(() => this.#add(form, button, restore)).catch((error) => {
      console.error('[bundle-ladder]', error);

      // Said here rather than by falling back to a native submit: that would navigate to
      // the cart and throw away anything still queued behind this one.
      this.#restoreButton(button, restore);
      this.#setStatus(form.closest('[data-blb-row]'), this.dataset.errorMessage || 'That did not add. Try again.', {
        undo: false,
      });
    });
  };

  /** @param {Event} event */
  #onClick = (event) => {
    const button = /** @type {HTMLElement} */ (event.target)?.closest?.('[data-blb-undo]');
    if (!button) return;

    event.preventDefault();

    const row = button.closest('[data-blb-row]');
    const snapshot = row && this.#undoable.get(row);
    if (!snapshot) return;

    this.#enqueue(() => this.#undo(row, snapshot)).catch((error) => {
      console.error('[bundle-ladder]', error);
      this.#setStatus(row, 'That did not undo cleanly. Open your cart to check it.', { undo: false });
    });
  };

  /**
   * What each row would have to do to put the cart back the way it found it. Keyed by row
   * so a shopper who adds two ladder options can still undo either one.
   *
   * @type {WeakMap<Element, {added: number, removed: {id: number, quantity: number}[]}>}
   */
  #undoable = new WeakMap();

  /**
   * @param {HTMLFormElement} form
   * @param {Element | null} button
   * @param {string} restore - The button's label, captured before it said "Adding".
   */
  async #add(form, button, restore) {
    const row = form.closest('[data-blb-row]');
    const variantId = Number(form.querySelector('input[name="id"]')?.getAttribute('value'));

    if (!variantId) throw new Error('Ladder row has no variant id');

    const sections = cartSectionIds();
    const sectionsPayload = sections.length
      ? { sections: sections.join(','), sections_url: window.location.pathname }
      : {};

    const added = await postJSON(`${this.#routes.add}.js`, {
      items: [{ id: variantId, quantity: 1 }],
      ...sectionsPayload,
    });

    const { sections: freshSections, itemCount, removed } = await this.#reconcile({
      form,
      sections,
      sectionsPayload,
      addedSections: added?.sections,
    });

    if (row) this.#undoable.set(row, { added: variantId, removed });

    announceCartUpdate(this, {
      action: this.dataset.afterAdd === 'open' ? 'add' : 'update',
      sections: freshSections,
      itemCount,
    });

    this.#showAdded(button, restore);
    this.#setStatus(row, this.#addedMessage(removed), { undo: removed.length > 0 });
  }

  /**
   * Drops the lines this row supersedes. Runs after the add, against a freshly read cart,
   * so it sees whatever the shopper actually has rather than whatever the page was
   * rendered with — carts go stale in a second tab, and a stale line key deletes nothing.
   *
   * @param {object} options
   * @param {HTMLFormElement} options.form
   * @param {string[]} options.sections
   * @param {object} options.sectionsPayload
   * @param {Record<string, string> | undefined} options.addedSections
   */
  async #reconcile({ form, sections, sectionsPayload, addedSections }) {
    const replaces = new Set((form.dataset.replaces || '').split(',').filter(Boolean));

    // A row that lists its own product is a theme-editor slip, and honouring it would
    // delete the thing that was just added. Refuse rather than obey.
    replaces.delete(String(form.dataset.productId || ''));

    const cart = await getJSON(`${this.#routes.cart}.js`);

    if (!replaces.size) return { sections: addedSections, itemCount: cart.item_count, removed: [] };

    /** @type {Record<string, number>} */
    const updates = {};
    /** @type {{id: number, quantity: number, title: string}[]} */
    const removed = [];

    for (const line of cart.items || []) {
      if (!replaces.has(String(line.product_id))) continue;

      updates[line.key] = 0;
      removed.push({ id: line.variant_id, quantity: line.quantity, title: line.product_title || line.title });
    }

    if (!removed.length) return { sections: addedSections, itemCount: cart.item_count, removed };

    const updated = await postJSON(`${this.#routes.update}.js`, { updates, ...sectionsPayload });

    // The update response is newer than the add response, so its sections win.
    return { sections: sections.length ? updated.sections : undefined, itemCount: updated.item_count, removed };
  }

  /**
   * @param {Element} row
   * @param {{added: number, removed: {id: number, quantity: number}[]}} snapshot
   */
  async #undo(row, snapshot) {
    const sections = cartSectionIds();
    const sectionsPayload = sections.length
      ? { sections: sections.join(','), sections_url: window.location.pathname }
      : {};

    if (snapshot.removed.length) {
      await postJSON(`${this.#routes.add}.js`, {
        items: snapshot.removed.map(({ id, quantity }) => ({ id, quantity })),
      });
    }

    // Re-read rather than trusting the line key captured before the add: re-adding the
    // removed items may have reshuffled the cart.
    const cart = await getJSON(`${this.#routes.cart}.js`);

    /** @type {Record<string, number>} */
    const updates = {};
    for (const line of cart.items || []) {
      if (line.variant_id === snapshot.added) updates[line.key] = 0;
    }

    const updated = Object.keys(updates).length
      ? await postJSON(`${this.#routes.update}.js`, { updates, ...sectionsPayload })
      : cart;

    this.#undoable.delete(row);

    announceCartUpdate(this, {
      action: 'update',
      sections: sections.length ? updated.sections : undefined,
      itemCount: updated.item_count,
    });

    this.#setStatus(row, 'Put back the way it was.', { undo: false });
  }

  /**
   * @param {{title: string}[]} removed
   * @returns {string}
   */
  #addedMessage(removed) {
    if (!removed.length) return this.dataset.addedMessage || 'Added to your cart.';

    const titles = removed.map(({ title }) => title);
    const list =
      titles.length === 1
        ? titles[0]
        : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;

    const template = this.dataset.replacedMessage || 'Added. [items] came out of your cart — this covers it, so you are not paying twice.';

    return template.replace('[items]', list);
  }

  /**
   * @param {Element | null} row
   * @param {string} message
   * @param {{undo: boolean}} options
   */
  #setStatus(row, message, { undo }) {
    const status = row?.querySelector('[data-blb-status]');
    if (!(status instanceof HTMLElement)) return;

    status.textContent = message;

    if (undo) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'blb__undo';
      button.textContent = this.dataset.undoLabel || 'Undo';
      button.setAttribute('data-blb-undo', '');
      status.append(' ', button);
    }

    status.hidden = false;
  }

  /**
   * @param {Element | null} button
   * @returns {string} The label to put back.
   */
  #showPending(button) {
    if (!(button instanceof HTMLButtonElement)) return '';

    const label = button.textContent || '';
    button.disabled = true;
    button.textContent = this.dataset.addingLabel || 'Adding…';

    return label;
  }

  /**
   * @param {Element | null} button
   * @param {string} label
   */
  #showAdded(button, label) {
    if (!(button instanceof HTMLButtonElement)) return;

    button.textContent = this.dataset.addedLabel || 'Added ✓';

    // Re-enabled rather than left dead: a ladder row is a real product and a shopper is
    // allowed to want two of it.
    setTimeout(() => {
      if (button.isConnected) this.#restoreButton(button, label);
    }, ADDED_LABEL_MS);
  }

  /**
   * @param {Element | null} button
   * @param {string} label
   */
  #restoreButton(button, label) {
    if (!(button instanceof HTMLButtonElement)) return;

    button.disabled = false;
    button.textContent = label;
  }
}

if (!customElements.get('bundle-ladder')) {
  customElements.define('bundle-ladder', BundleLadder);
}
