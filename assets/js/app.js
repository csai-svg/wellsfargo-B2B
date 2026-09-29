/* Wells Fargo B2B Store - shared client logic.

   THIS STORE SHOWS NO PRICES. The feed sends every product with base_price 0
   and an empty tiers array (see apps-script-feed/Code.gs), and the templates
   render quantities only. The tier/MOQ engine below is still here because the
   cart uses it to group lines by parent SKU, but every figure it produces is
   zero and nothing renders it. Do not re-add money to a template without
   also changing the feed — a price of ₹0.00 on a card reads as "free". */

const CONFIG = {
  // Apps Script Web App /exec URL (apps-script-feed/Code.gs). The same URL
  // serves the live catalogue (GET ?fn=catalog) and receives cart submissions
  // (POST).
  FEED_URL: 'https://script.google.com/macros/s/AKfycby7wry_8KHpl7RHcyGEAt5wM_TrF6pAjbOfl2OcxNvIcZSM9bg3YU6IPLfZKQtsWKeI8w/exec',
  API_URL: '',
  API_TOKEN: '',
  CURRENCY: '₹',
  BRAND: 'Wells Fargo',
};
if (CONFIG.FEED_URL && !CONFIG.API_URL) CONFIG.API_URL = CONFIG.FEED_URL;

/* ---------------------------------------------------------------- utilities */

const money = n =>
  CONFIG.CURRENCY + Number(n || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

const qty = n => Number(n || 0).toLocaleString('en-IN');

const param = k => new URLSearchParams(location.search).get(k) || '';

/* Delays fn until wait ms after the last call — used so typing into a filter
   field doesn't re-render the whole grid on every keystroke. */
function debounce_(fn, wait = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    // Coerce anything that is not already a Node (numbers especially) to text,
    // otherwise appendChild throws on a plain value.
    n.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

function toast(msg, kind = 'info') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = el('div', { class: 'toast toast-' + kind }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
}

/* --------------------------------------------------------------- API client */

/* Apps Script cannot answer a CORS preflight, so every POST goes out as
   text/plain with a JSON string body. Changing this breaks all writes. */
async function api(fn, payload = {}) {
  if (!CONFIG.API_URL) throw new Error('API_URL is not configured yet.');
  let res;
  try {
    res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn, token: CONFIG.API_TOKEN, session: Auth.token(), ...payload }),
    });
  } catch (err) {
    /* fetch only rejects on a network-level failure, and the browser's own
       wording for that is the unhelpful "Failed to fetch". */
    throw new Error('The backend did not respond. Check your connection and try again.');
  }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* Same envelope as api(), over XMLHttpRequest, because fetch cannot report
   upload progress and evidence files are large enough for a submit to look
   frozen without a bar. */
function apiUpload(fn, payload = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', CONFIG.API_URL, true);
    xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.upload.onload = () => onProgress(1);
    }
    xhr.onload = () => {
      let d;
      try { d = JSON.parse(xhr.responseText); }
      catch (err) { reject(new Error('The server sent a reply we could not read.')); return; }
      if (!d.ok) reject(new Error(d.error || 'Request failed'));
      else resolve(d);
    };
    xhr.onerror = () => {
      const err = new Error('The upload did not reach the server. Check your connection.');
      err.transport = true;             // lets the caller retry over fetch
      reject(err);
    };
    xhr.send(JSON.stringify({ fn, token: CONFIG.API_TOKEN, session: Auth.token(), ...payload }));
  });
}

/* ---------------------------------------------------------------- tracking */

/* Fire-and-forget usage events. Analytics must never be able to break the
   shop, so every call is wrapped, unawaited, and silent on failure. Nothing
   personal is recorded beyond the email of someone already signed in. */
const Track = {
  /* A session is one browser tab visit; a visitor persists across visits.
     Both are random ids with nothing personal in them, and the visitor id is
     what makes "new vs returning" possible at all. */
  vid() {
    try {
      let v = localStorage.getItem('cs_vid');
      if (!v) {
        v = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('cs_vid', v);
        return { id: v, isNew: true };
      }
      return { id: v, isNew: false };
    } catch (err) {
      return { id: '', isNew: false };   // storage blocked; count it as a session only
    }
  },

  sid() {
    let s = sessionStorage.getItem('cs_sid');
    if (!s) {
      s = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('cs_sid', s);
    }
    return s;
  },

  /* Searches fire once the typing settles, otherwise every keystroke becomes
     a row. A search that found nothing is recorded separately: that list is
     the most useful thing on the dashboard, because it is people asking for
     products the catalogue does not have. */
  _searchTimer: null,
  search(q, results) {
    clearTimeout(this._searchTimer);
    const term = (q || '').trim();
    if (term.length < 2) return;
    this._searchTimer = setTimeout(() => {
      this.event(results ? 'search' : 'search_empty', { query: term, qty: results });
    }, 900);
  },

  event() { /* analytics disabled on the view-only catalogue */ },
  _event_disabled(name, props = {}) {
    try {
      const u = Auth.user();
      const v = this.vid();
      // referrer is only meaningful on the first page of a visit
      const firstOfSession = !sessionStorage.getItem('cs_seen');
      if (firstOfSession) sessionStorage.setItem('cs_seen', '1');

      const body = JSON.stringify({
        fn: 'track', token: CONFIG.API_TOKEN,
        session: this.sid(), visitor: v.id, event: name,
        is_new: v.isNew ? 1 : 0,
        ref: firstOfSession ? (document.referrer || '') : '',
        path: location.pathname.split('/').pop() || 'index.html',
        title: document.title.replace(' | Wells Fargo Merchandise Store', ''),
        user_email: u ? u.email : '',
        ua: navigator.userAgent,
        ...props,
      });
      // keepalive so an event fired during navigation still leaves the page
      fetch(CONFIG.API_URL, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
      }).catch(() => {});
    } catch (err) {
      /* never surface an analytics failure to a shopper */
    }
  },
};

/* ------------------------------------------------------------------- catalogue */

/* ------------------------------------------------------------------
   Category grouping
   The catalogue sheet stores one flat product tag per SKU (Backpacks,
   Polos, Pens, ...). The storefront nav wants four merchandising
   headings with those tags hanging off them as subcategories. Rather
   than reshaping the sheet — which the Apps Script publish step would
   overwrite on the next republish — the grouping is applied client-side
   right after the catalogue loads: each product's `category` is
   rewritten to its group and `subcategory` keeps the original tag, so
   category.html, the filter bar and the nav all keep working unchanged.
   A tag that is not listed here falls through to Utilities.
   ------------------------------------------------------------------ */
/* The five storefront categories, in nav order. Products already carry their
   final category (assigned from the sheet at build/feed time); we keep it and
   use brand as the subcategory for the dropdowns. "Gift Box" products exist
   but are surfaced on the Build-a-kit page, not in the top nav. */
const NAV_CATEGORIES = ['Apparel', 'Drinkware', 'Travel', 'Utilities', 'Tech'];
const CATEGORY_FALLBACK_GROUP = 'Utilities';

/* Rewrites the loaded catalogue in place: products get their group as
   `category` and their original tag as `subcategory`; `categories` is
   rebuilt as the four groups, each listing only the tags that actually
   have products behind them (so the dropdowns never show a dead link). */
function regroupCatalogue(data, taxonomy) {
  taxonomy = taxonomy || {};
  const seen = {};
  for (const p of data.products || []) {
    const t = taxonomy[p.sku];
    if (t) { p.category = t.category; p.subcategory = t.subcategory; }
    let group = p.category;
    if (!NAV_CATEGORIES.includes(group) && group !== 'Gift Box') group = CATEGORY_FALLBACK_GROUP;
    p.category = group;
    p.subcategory = p.subcategory || p.brand || group;
    if (group === 'Gift Box') continue; // kept as products, kept out of top nav
    (seen[group] || (seen[group] = new Set())).add(p.subcategory);
  }
  data.categories = NAV_CATEGORIES
    .filter(group => seen[group] && seen[group].size)
    .map(group => ({
      slug: group,
      label: group,
      subcategories: [...seen[group]].sort(),
    }));
  return data;
}

/* ------------------------------------------------------------------
   Colourways
   Some styles ship as one SKU per colour, exported with identical
   product names — so the storefront showed the same lanyard three
   times. assets/colorways.json groups those SKUs; listings then show
   only the group's `primary`, and the product page offers swatches
   that switch between members. Every colour keeps its own SKU, price,
   MOQ and stock, so nothing about ordering changes. A member marked
   needs_image is held out of listings and gets no swatch until real
   photography lands.
   ------------------------------------------------------------------ */
function applyColorways(data, groups) {
  const primary = new Set();
  const hidden = new Set();

  for (const g of groups || []) {
    const members = (g.members || []).filter(m => Catalogish(data, m.sku));
    if (members.length < 2) continue;
    const head = members.find(m => m.sku === g.primary) || members[0];
    primary.add(head.sku);

    /* swatch-worthy members only: one still awaiting photography has no
       colour to show, so it is reachable by URL but not advertised */
    const shown = members.filter(m => m.color && !m.needs_image);
    for (const m of members) {
      const p = Catalogish(data, m.sku);
      const label = g.label || p.name;
      p.colorway = {
        group: g.id,
        label: label,
        color: m.color || '',
        needs_image: !!m.needs_image,
        siblings: shown.map(x => ({ sku: x.sku, color: x.color, swatch: x.swatch })),
      };
      /* The export gave every colour the same name — all three lanyards read
         "- Black". Rebuild the name from the group label plus this member's
         actual colour so the yellow one does not claim to be black. (This is
         also where the group label quietly fixes the "Hooodie" typo.) */
      p.name = m.color ? label + ' - ' + m.color : label;
      if (m.sku !== head.sku) hidden.add(m.sku);
    }
  }
  return data.products.filter(p => !hidden.has(p.sku));
}

function Catalogish(data, sku) {
  return data.products.find(p => p.sku === sku);
}

/* Neutral placeholder shown until real product photography is supplied. */
const PLACEHOLDER_IMG = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
  '<rect width="100%" height="100%" fill="#f1f1f1"/>' +
  '<text x="50%" y="50%" fill="#9aa0a6" font-family="system-ui,-apple-system,sans-serif" ' +
  'font-size="18" text-anchor="middle" dominant-baseline="middle">Image coming soon</text></svg>');

/* Product photos are served straight off Google Drive, either as a thumbnail
   proxy URL (drive.google.com/thumbnail?id=<fileId>&sz=w1200 — the current
   format) or the older lh3.googleusercontent.com/d/<id>=w1200 proxy form.
   Both are served at a fixed width no matter how small they're actually
   shown, so this rewrites the size parameter to whatever the call site
   needs (a 52px thumbnail shouldn't download a full-size original). Passes
   anything else (the data: placeholder, a non-Drive URL) through unchanged. */
function imgAt(url, w) {
  if (!url || url.startsWith('data:')) return url;
  if (url.includes('drive.google.com/thumbnail')) {
    return /[?&]sz=/.test(url) ? url.replace(/([?&]sz=)w?\d+/, '$1w' + w) : url + '&sz=w' + w;
  }
  if (url.includes('googleusercontent.com')) return url.replace(/=w\d+$/, '=w' + w);
  return url;
}

/* Live catalogue from the Apps Script feed when configured, else the bundled
   snapshot. The feed returns ONLY public columns (no cost/margins); the master
   sheet stays private. A slow/failed feed falls back to the snapshot so the
   store always renders. */
/* Apps Script web apps block cross-origin fetch() (CORS), so the live feed is
   loaded via JSONP (a <script> tag calling back a global) — Code.gs returns
   `callback(json)` when ?callback= is present. No CORS, no redeploy. */
function jsonp(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const cb = '__feedcb_' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    let done = false;
    const cleanup = () => { try { delete window[cb]; } catch (e) { window[cb] = undefined; } s.remove(); };
    const timer = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error('jsonp timeout')); } }, timeoutMs);
    window[cb] = data => { if (done) return; done = true; clearTimeout(timer); cleanup(); resolve(data); };
    s.onerror = () => { if (done) return; done = true; clearTimeout(timer); cleanup(); reject(new Error('jsonp error')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}

/* Render instantly, sync in the background. First paint uses a live feed
   result cached earlier this session, else the bundled snapshot — never blocks
   on the (sometimes slow) Apps Script call. Meanwhile the feed is fetched and
   cached, so the next page navigation shows the latest sheet data. */
function feedUrl() {
  return CONFIG.FEED_URL + '?fn=catalog&brand=' + encodeURIComponent(CONFIG.BRAND)
    + (CONFIG.API_TOKEN ? '&token=' + encodeURIComponent(CONFIG.API_TOKEN) : '');
}
function refreshFeedCache() {
  if (!CONFIG.FEED_URL) return;
  jsonp(feedUrl(), 12000)
    .then(d => { if (d && Array.isArray(d.products) && d.products.length) { try { sessionStorage.setItem('cs_feed', JSON.stringify(d)); } catch (e) {} } })
    .catch(() => {});
}
async function loadCatalogueJSON() {
  let base = null;
  try { const c = sessionStorage.getItem('cs_feed'); if (c) base = JSON.parse(c); } catch (e) {}
  if (!base || !Array.isArray(base.products) || !base.products.length) {
    base = await fetch('assets/products.json').then(r => r.json());
  }
  refreshFeedCache();   // background, non-blocking — updates the cache for the next page
  return base;
}

const Catalog = {
  _data: null,
  async load() {
    if (this._data) return this._data;
    const [raw, cw, tax] = await Promise.all([
      loadCatalogueJSON(),
      fetch('assets/colorways.json').then(r => r.ok ? r.json() : { groups: [] }).catch(() => ({ groups: [] })),
      fetch('assets/taxonomy.json').then(r => r.ok ? r.json() : {}).catch(() => ({})),
      Site.load(),
    ]);
    this._data = regroupCatalogue(raw, tax);
    for (const p of this._data.products) if (!p.image) p.image = PLACEHOLDER_IMG;
    /* bySku indexes EVERY product, including colours hidden from listings,
       so a direct product.html?sku=... link always resolves */
    this._bySku = Object.fromEntries(this._data.products.map(p => [p.sku, p]));
    this._listing = applyColorways(this._data, cw.groups);
    return this._data;
  },
  /* what listings show: one card per colourway */
  get products() { return this._listing || (this._data ? this._data.products : []); },
  /* every SKU, siblings included */
  get allProducts() { return this._data ? this._data.products : []; },
  get categories() { return this._data ? this._data.categories : []; },
  get eventKits() { return this._data ? (this._data.event_kits || []) : []; },
  bySku(sku) { return this._bySku[sku]; },
  eventKit(slug) { return this.eventKits.find(k => k.slug === slug); },
};

/* Banners and site settings, published alongside products.json. Absent on a
   store that has never published, so every read is defensive. */
const Site = {
  settings: {}, banners: [], departments: [],
  async load() {
    try {
      const res = await fetch('assets/site.json');
      if (!res.ok) return;
      const d = await res.json();
      this.settings = d.settings || {};
      this.banners = d.banners || [];
      /* Published alongside the catalogue so checkout does not have to wait on
         a live Apps Script call to fill two dropdowns. */
      this.departments = d.departments || [];
    } catch (err) {
      // a missing site.json is not an error, the defaults below cover it
    }
  },
  get(key, fallback) {
    const v = this.settings[key];
    return v === undefined || v === '' ? fallback : v;
  },
};

/* --------------------------------------------------------------------- auth */

const Auth = {
  token() { return sessionStorage.getItem('cs_session') || ''; },
  user() {
    try { return JSON.parse(sessionStorage.getItem('cs_user') || 'null'); }
    catch { return null; }
  },
  set(token, user) {
    sessionStorage.setItem('cs_session', token);
    sessionStorage.setItem('cs_user', JSON.stringify(user));
  },
  clear() {
    sessionStorage.removeItem('cs_session');
    sessionStorage.removeItem('cs_user');
  },
  /* Catalogue is public. Only checkout calls this. */
  require(next) {
    if (this.user()) return true;
    location.href = 'login.html?next=' + encodeURIComponent(next || location.pathname.split('/').pop());
    return false;
  },
};

/* --------------------------------------------------------------------- cart */

const Cart = {
  read() {
    try { return JSON.parse(sessionStorage.getItem('cs_cart') || '[]'); }
    catch { return []; }
  },
  write(items) {
    sessionStorage.setItem('cs_cart', JSON.stringify(items));
    Cart.paintCount();
  },
  /* One line per variant. Sized products key on variant_sku, plain products on sku. */
  add(sku, size, n) {
    const items = Cart.read();
    const key = size ? sku + '_' + size : sku;
    const hit = items.find(i => i.key === key);
    if (hit) hit.qty += n;
    else items.push({ key, sku, size: size || '', qty: n });
    Cart.write(items);
  },
  setQty(key, n) {
    const items = Cart.read();
    const hit = items.find(i => i.key === key);
    if (!hit) return;
    if (n <= 0) return Cart.remove(key);
    hit.qty = n;
    Cart.write(items);
  },
  remove(key) { Cart.write(Cart.read().filter(i => i.key !== key)); },
  clear() { sessionStorage.removeItem('cs_cart'); Cart.paintCount(); },
  count() { return Cart.read().reduce((a, i) => a + i.qty, 0); },
  paintCount() {
    const n = Cart.count();
    document.querySelectorAll('[data-cart-count]').forEach(e => {
      e.textContent = n;
      e.classList.toggle('hidden', n === 0);
    });
  },
};

/* ---------------------------------------------------------------- pricing */

/* Tier resolution, per the client rule:
   quantity rolls up by PARENT SKU across sizes, the matching tier's unit price
   applies to every line in that group, and the group total must meet the MOQ. */
function priceCart(items, lookup) {
  const groups = {};
  for (const it of items) {
    (groups[it.sku] = groups[it.sku] || []).push(it);
  }

  const lines = [];
  const groupInfo = {};
  let subtotal = 0, taxTotal = 0;

  for (const [sku, gitems] of Object.entries(groups)) {
    const p = lookup(sku);
    if (!p) continue;

    const groupQty = gitems.reduce((a, i) => a + i.qty, 0);
    const tier = pickTier(p.tiers, groupQty);
    const unit = tier ? tier.unit_price : p.base_price;
    const next = nextTier(p.tiers, groupQty);

    groupInfo[sku] = {
      product: p,
      groupQty,
      tier,
      unit,
      next,
      gst: tierGst(tier, p),
      needForNext: next ? next.min_qty - groupQty : 0,
      meetsMoq: groupQty >= p.moq,
      shortBy: Math.max(0, p.moq - groupQty),
    };

    const gst = tierGst(tier, p);

    for (const it of gitems) {
      const lineTotal = unit * it.qty;
      const tax = lineTotal * (gst / 100);
      subtotal += lineTotal;
      taxTotal += tax;
      lines.push({
        ...it, product: p, groupQty, unit, lineTotal,
        gst_rate: gst, tax, lineTotalWithTax: lineTotal + tax,
        tierLabel: tier ? tierLabel(tier) : '',
      });
    }
  }

  /* Ordering under the MOQ is allowed: the vendor may still accept it, and a
     requester who needs eight of something should not be forced to buy
     twenty-five. It is flagged everywhere it appears rather than blocked, and
     the approver sees the flag before deciding. */
  const belowMoq = Object.values(groupInfo).filter(g => !g.meetsMoq);

  /* Shipping and handling, the same rule the backend applies in priceOrder():
     a percentage of the goods value before GST, added after tax and not taxed
     itself. The rate is published in site.json so this can be shown in the
     cart; the backend recomputes it from the Sheet and stays the authority. */
  const shippingPct = Number(Site.get('shipping_pct', 8));
  const shippingTotal = Math.round(subtotal * (isFinite(shippingPct) ? shippingPct : 8)) / 100;

  return {
    lines, groups: groupInfo, subtotal, taxTotal,
    shippingPct: isFinite(shippingPct) ? shippingPct : 8,
    shippingTotal,
    grandTotal: subtotal + taxTotal + shippingTotal,
    belowMoq,
    blocked: belowMoq,        // old name, kept so nothing breaks mid-deploy
    valid: lines.length > 0,
  };
}

/**
 * The GST rate for a tier: its own if it states one, otherwise the product's.
 *
 * Apparel sits in a slab that turns on the per-unit price, so the same shirt
 * is 18% at one unit and 5% at five hundred. Mirrors tierGst() in
 * apps-script/Orders.gs, which is the authority — change both together.
 */
function tierGst(tier, product) {
  const t = tier && tier.gst_rate;
  if (t !== null && t !== undefined && t !== '' && isFinite(Number(t))) return Number(t);
  return Number((product && product.gst_rate) || 0);
}

/* Highest tier whose min_qty is still <= the group quantity. */
function pickTier(tiers, n) {
  let best = null;
  for (const t of tiers || []) {
    if (n >= t.min_qty && (!best || t.min_qty > best.min_qty)) best = t;
  }
  return best;
}

function nextTier(tiers, n) {
  let best = null;
  for (const t of tiers || []) {
    if (t.min_qty > n && (!best || t.min_qty < best.min_qty)) best = t;
  }
  return best;
}

function tierLabel(t) {
  return t.max_qty ? `${t.min_qty}–${t.max_qty}` : `${t.min_qty}+`;
}

/* unitAt(), lowestPrice(), hasPrice() and PRICE_ON_REQUEST lived here. They
   all answered "what does this cost", which this store never asks: the feed
   sends base_price 0 and no tiers for every product, so each of them returned
   0 or false for the whole catalogue and nothing called them any more.

   priceCart() and pickTier() above are deliberately kept — the cart still
   uses them to roll lines up by parent SKU, which is how the size split and
   the per-product blocks work. They return zeros, and nothing renders those
   zeros. If prices ever come back, they come back in the feed first. */

/* ------------------------------------------------------------- filtering */

/* One filter model shared by the category pages and the all-products page.
   There is no price or MOQ filter: this store publishes neither, and a
   control that silently matches everything is worse than no control. */
const Filters = {
  state: { q: '', sort: 'featured', cat: '', sub: '',
           brand: '', tag: '', topSelling: false, sustainable: false },

  reset() {
    this.state = { q: '', sort: 'featured', cat: '', sub: '',
                   brand: '', tag: '', topSelling: false, sustainable: false };
  },

  matches(p) {
    const s = this.state;
    if (s.cat && p.category !== s.cat) return false;
    if (s.sub && p.subcategory !== s.sub) return false;
    if (s.brand && p.brand !== s.brand) return false;
    if (s.tag && !(p.event_tags || []).includes(s.tag)) return false;
    if (s.topSelling && !p.top_selling) return false;
    if (s.sustainable && !p.sustainable) return false;
    const q = s.q.trim().toLowerCase();
    if (!q) return true;
    const hay = `${p.name} ${p.sku} ${p.category} ${p.subcategory} ${p.description || ''}`.toLowerCase();
    return q.split(/\s+/).every(w => hay.includes(w));
  },

  apply(products) {
    const s = this.state;
    const out = products.filter(p => this.matches(p));
    if (s.sort === 'az') out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  },

  /* Renders the bar into `host`. `opts.categories` adds a category select,
     which the all-products page wants and a category page does not. */
  bar(host, opts, onChange) {
    opts = opts || {};
    const s = this.state;
    const fireNow = () => onChange();
    /* The search box re-renders 200ms after the last keystroke rather than
       on every one. Discrete choices (the selects, Reset) fire right away,
       since there is no keystroke stream to coalesce. */
    const fire = debounce_(fireNow, 200);

    const field = (label, input) =>
      el('label', { class: 'fbar-fld' }, el('span', {}, label), input);

    const search = el('input', {
      type: 'search', id: 'fq', placeholder: 'Search name or SKU', value: s.q,
      oninput: e => { s.q = e.target.value; fire(); },
    });

    const sort = el('select', {
      id: 'fsort', onchange: e => { s.sort = e.target.value; fireNow(); },
    }, [['featured', 'Featured'], ['az', 'Name A–Z']].map(([v, t]) =>
      el('option', { value: v, selected: s.sort === v ? 'selected' : null }, t)));

    const bits = [field('Search', search), field('Sort', sort)];

    if (opts.categories) {
      const cat = el('select', {
        id: 'fcat', onchange: e => { s.cat = e.target.value; s.sub = ''; fireNow(); },
      }, el('option', { value: '' }, 'All categories'),
         ...opts.categories.map(c => el('option', { value: c, selected: s.cat === c ? 'selected' : null }, c)));
      bits.splice(1, 0, field('Category', cat));
    }

    host.append(el('div', { class: 'fbar' }, ...bits,
      el('button', {
        class: 'btn btn-ghost btn-sm', style: 'margin-left:auto',
        onclick: () => { const keep = s.cat, sub = s.sub; Filters.reset();
          Filters.state.cat = opts.keepCategory ? keep : ''; Filters.state.sub = opts.keepCategory ? sub : '';
          host.textContent = ''; Filters.bar(host, opts, onChange); fireNow(); },
      }, 'Reset')));
  },

  /* Renders the always-visible left-hand facet rail into `host`: Tags,
     Select By Brand, and the two merchandising toggles. `opts.products`
     is the full (unfiltered) catalogue, used only to derive the distinct
     brand/tag values on offer — filtering itself still goes through
     matches()/apply() like every other Filters control. Includes its own
     mobile "Filters" toggle button so callers don't have to build one. */
  sidebar(host, opts, onChange) {
    opts = opts || {};
    const s = this.state;
    const products = opts.products || [];
    const fireNow = () => onChange();
    const repaint = () => { host.textContent = ''; Filters.sidebar(host, opts, onChange); };

    const brands = [...new Set(products.map(p => p.brand).filter(Boolean))].sort();
    const tags = [...new Set(products.flatMap(p => p.event_tags || []))].sort();

    const section = (title, body) => el('div', { class: 'rail-sec' },
      el('h3', { class: 'rail-title' }, title), body);

    const highlightChip = (label, key) => el('button', {
      class: 'chip' + (s[key] ? ' on' : ''), type: 'button',
      onclick: () => { s[key] = !s[key]; repaint(); fireNow(); },
    }, label);

    const tagChips = el('div', { class: 'rail-chips' },
      highlightChip('Wells Fargo Top Selling', 'topSelling'),
      highlightChip('Sustainable', 'sustainable'),
      ...tags.map(t => el('button', {
        class: 'chip' + (s.tag === t ? ' on' : ''), type: 'button',
        onclick: () => { s.tag = s.tag === t ? '' : t; repaint(); fireNow(); },
      }, t)));

    const brandList = brands.length
      ? el('div', { class: 'rail-list' }, brands.map(b => el('label', { class: 'rail-check' },
          el('input', {
            type: 'checkbox', checked: s.brand === b ? 'checked' : null,
            onchange: e => { s.brand = e.target.checked ? b : ''; repaint(); fireNow(); },
          }), el('span', {}, b))))
      : el('p', { class: 'muted small' }, 'No brands yet');

    const toggle = (label, key) => el('label', { class: 'rail-check' },
      el('input', {
        type: 'checkbox', checked: s[key] ? 'checked' : null,
        onchange: e => { s[key] = e.target.checked; fireNow(); },
      }), el('span', {}, label));

    const rail = el('aside', { class: 'filter-rail', id: 'filterRail' },
      section('Tags', tagChips),
      section('Select By Brand', brandList),
      section('Highlights', el('div', { class: 'rail-list' },
        toggle('Wells Fargo Top Selling', 'topSelling'),
        toggle('Sustainable', 'sustainable'))),
      el('button', {
        class: 'btn btn-ghost btn-sm rail-clear', type: 'button',
        onclick: () => { s.brand = ''; s.tag = ''; s.topSelling = false; s.sustainable = false; repaint(); fireNow(); },
      }, 'Clear filters'));

    host.append(
      el('button', {
        class: 'btn btn-ghost rail-toggle-btn', type: 'button',
        onclick: () => rail.classList.toggle('rail-open'),
      }, 'Filters'),
      rail);
  },
};

/* ----------------------------------------------------------- kit builder */

/* The kit builder that used to sit here (kitEligible / buildOneKit /
   buildKits) was removed with the pricing. Every one of its decisions was a
   budget comparison — "which products fit ₹X per head" — so with no prices it
   has nothing to optimise against and would only ever return empty kits.
   kit.html and preset-kits.html went with it. If Wells Fargo later wants
   kits, they need either real prices or a different rule (by category or by
   a curated list), not this code with the money taken out. */

const ICONS = {
  user: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="8" r="3.6"/>' +
        '<path d="M4.6 20c1.3-3.7 4-5.6 7.4-5.6S18.1 16.3 19.4 20"/></svg>',
  cart: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M2.5 4h2.3l2.2 10.5h9.6L19 7H6.4"/><circle cx="9.5" cy="19" r="1.5"/>' +
        '<circle cx="16.5" cy="19" r="1.5"/></svg>',
  search: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/>' +
          '<path d="M15.5 15.5 21 21"/></svg>',
  burger: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
         'stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/* Three bands: account strip, logo and search, then the category rail. */
function header(active) {
  const u = Auth.user();
  /* The rail follows the catalogue, so a new heading appears the moment a
     product is published under it. The four originals are the fallback for
     pages that mount before the catalogue is loaded. */
  const cats = Catalog.categories.length
    ? Catalog.categories.map(c => c.slug)
    : NAV_CATEGORIES.slice();

  return el('header', { class: 'site-head' },
    el('div', { class: 'wrap head-inner' },
      el('button', {
        class: 'burger', type: 'button', 'aria-label': 'Menu',
        onclick: () => openMenu(active), html: ICONS.burger,
      }),
      el('a', { class: 'brand', href: 'index.html' },
        el('img', { class: 'brand-logo', alt: 'Wells Fargo',
          src: Site.get('logo_url', 'assets/brand/logo.png') })),
      el('form', { class: 'search', action: 'all.html', method: 'get' },
        el('input', { type: 'search', name: 'q', 'aria-label': 'Search products',
          placeholder: 'Search products…' }),
        el('button', { type: 'submit', 'aria-label': 'Search', html: ICONS.search })),
      el('div', { class: 'head-icons' },
        el('a', { class: 'icon-btn', href: 'cart.html', title: 'Cart', html: ICONS.cart },
          el('span', { 'data-cart-count': '1', class: 'pill hidden' }, '0')))),

    el('nav', { class: 'catnav' },
      el('div', { class: 'wrap catnav-inner' },
        cats.map(c => catnavItem(c, active)),
        el('a', { class: 'catnav-top' + (active === 'All' ? ' on' : ''), href: 'all.html' },
          'All products'))));
}

/* One category plus its subcategories. The subcategory list comes from the
   catalogue, so a new subcategory appears in the rail without a code change. */
function catnavItem(cat, active) {
  /* login.html, reset.html and status.html mount the chrome without loading
     the catalogue, so there may be no subcategories to hang a menu on. */
  const meta = Catalog.categories.find(c => c.slug === cat);
  const subs = meta ? meta.subcategories : [];
  const href = 'category.html?cat=' + encodeURIComponent(cat);

  return el('div', { class: 'catnav-item' },
    el('a', { class: 'catnav-top' + (active === cat ? ' on' : ''), href },
      cat, subs.length ? el('span', { class: 'caret' }, '\u02c5') : null),
    subs.length
      ? el('div', { class: 'catnav-menu' }, subs.map(s =>
          el('a', { href: href + '&sub=' + encodeURIComponent(s) }, s)))
      : null);
}

/* The category rail does not survive a phone: five headings with dropdowns
   either overflow or scroll sideways. On small screens the rail is hidden and
   this drawer carries the same links, subcategories included. */
function openMenu(active) {
  closeMenu();
  const u = Auth.user();
  const cats = Catalog.categories.length
    ? Catalog.categories
    : NAV_CATEGORIES.map(g => ({ slug: g, label: g, subcategories: [] }));

  const panel = el('nav', { class: 'menu-panel', 'aria-label': 'Site menu' },
    el('div', { class: 'menu-head' },
      el('span', { class: 'menu-title' }, 'Menu'),
      el('button', { class: 'menu-x', type: 'button', 'aria-label': 'Close', onclick: closeMenu, html: ICONS.close })),

    el('div', { class: 'menu-body' },
      cats.map(c => el('div', { class: 'menu-group' },
        el('a', {
          class: 'menu-cat' + (active === c.slug ? ' on' : ''),
          href: 'category.html?cat=' + encodeURIComponent(c.slug),
        }, c.label),
        (c.subcategories || []).map(sub => el('a', {
          class: 'menu-sub',
          href: 'category.html?cat=' + encodeURIComponent(c.slug) + '&sub=' + encodeURIComponent(sub),
        }, sub)))),

      el('div', { class: 'menu-group' },
        el('a', { class: 'menu-cat', href: 'all.html' }, 'All products'))));

  const shade = el('div', {
    class: 'menu-shade', id: 'menuShade',
    onclick: e => { if (e.target.id === 'menuShade') closeMenu(); },
  }, panel);

  document.body.append(shade);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', menuEscape);
  panel.querySelector('a, button')?.focus();
}

function closeMenu() {
  document.getElementById('menuShade')?.remove();
  document.body.style.overflow = '';
  document.removeEventListener('keydown', menuEscape);
}

function menuEscape(e) {
  if (e.key === 'Escape') closeMenu();
}

function footer() {
  return el('footer', { class: 'site-foot' },
    el('div', { class: 'wrap foot-inner' },
      el('p', { class: 'foot-help' },
        'Questions about the store? Contact ',
        (function (a) { return el('a', { href: 'mailto:' + a }, a); })(
          Site.get('support_email', 'helpdesk@companystore.io')), '.'),
      el('p', { class: 'foot-note small' },
        Site.get('footer_note', 'Wells Fargo branded merchandise store \u2014 a view-only catalogue.')),
      el('p', { class: 'foot-copy small' },
        '\u00a9 ' + new Date().getFullYear() + ' Wells Fargo. Fulfilled by CompanyStore.IO.')));
}

function mount(active) {
  document.body.prepend(header(active));
  document.body.append(footer());
  Cart.paintCount();
}

/* Catalogue tile, shared by index.html and category.html. */
function productCard(p) {
  return el('a', { class: 'card', href: 'product.html?sku=' + encodeURIComponent(p.sku) },
    el('div', { class: 'card-img' }, el('img', { src: imgAt(p.image, 400), alt: p.name, loading: 'lazy' })),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-sku' }, p.brand || ''),
      (p.top_selling || p.sustainable) ? el('div', { class: 'card-badges' },
        p.top_selling ? el('span', { class: 'badge badge-top' }, 'Top Selling') : null,
        p.sustainable ? el('span', { class: 'badge badge-sustainable' }, 'Sustainable') : null) : null,
      el('div', { class: 'card-name' },
        (p.colorway && p.colorway.siblings.length > 1) ? p.colorway.label : p.name),
      p.has_sizes ? el('div', { class: 'tag' }, p.sizes.length + ' sizes') : null,
      (p.colorway && p.colorway.siblings.length > 1)
        ? el('div', { class: 'tag' }, p.colorway.siblings.length + ' colours') : null,
      /* No price and no MOQ line: the feed sends neither. The card ends on
         the name, so every tile is the same height without a spacer. */
      ));
}

/* Node test harness only. Ignored by the browser. */
if (typeof module !== 'undefined') {
  module.exports = { priceCart, pickTier, nextTier, tierLabel };
}
