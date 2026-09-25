# Wells Fargo B2B Store

A view-only merchandise catalogue. Static frontend on GitHub Pages, a Google
Sheet as the database, Apps Script as the API. No server, no framework, no
build step.

Built from the Deloitte B2B store's architecture. What was rebuilt rather than
inherited is listed under [What changed from Deloitte](#what-changed-from-deloitte).

---

## This store shows no prices

Deliberate, and enforced in the feed rather than in CSS.

`apps-script-feed/Code.gs` **never reads** the Cost Price, Margin, MOQ or any
of the five B2B price-band columns. Every product is served with `moq: 0`,
`gst_rate: 0`, `tiers: []` and `base_price: 0`.

Reading those columns and then blanking them would have put real cost and
margin figures into a public JSON response one refactor away from leaking.
Not reading them means the master sheet keeps its commercials and there is
nothing to leak.

The frontend follows: no price on the cards, no volume-pricing table, no MOQ
gate, no price or MOQ filters, no cart totals. The cart is a **request list** —
you pick quantities, submit, and the team replies with pricing and lead time.

If prices are ever wanted back, that is a change in `Code.gs` **and** in the
templates. Do not re-add the columns alone: a card reading `₹0.00` says "free".

---

## What is here

```
index.html       catalogue landing, hero + category tiles + featured row
category.html    listing with subcategory filters
all.html         whole catalogue, search and sort
product.html     detail, quantity entry, add to request
cart.html        request list grouped by parent SKU, size splitter, submit

assets/js/app.js         cart, API client, filters, page chrome
assets/css/app.css       Wells Fargo palette, all tokens in :root
assets/products.json     bundled catalogue snapshot (cold-start fallback)
assets/site.json         hero, banners, site name
assets/taxonomy.json     per-SKU category overrides (empty)
assets/colorways.json    colour-variant groupings (empty)
assets/brand/            hero artwork and wordmark — SEE assets/brand/README.md

apps-script-feed/Code.gs the backend: catalogue feed, image matcher, requests
scripts/build_seed_catalog.py  regenerates assets/products.json
```

`robots.txt` disallows everything and every page carries `noindex,nofollow`.

---

## Catalogue

| | |
|---|---|
| Products | 22 |
| With a photo | 9 |
| Awaiting a photo | 13 |
| Categories | Apparel 8, Travel 11, Drinkware 2, Utilities 1 |

Source of truth is the sheet:
[Copy of Wells Fargo New Catalog - 2026-27](https://docs.google.com/spreadsheets/d/1oy_PrlNb4tOH48eOKJBBYaJAEZ0h2FBwWDlcsQwAgjE),
tab `Sheet1`. SKUs are generated as `WF0001`…`WF0022` from the Sr No column —
a fresh sequence, not a continuation of Deloitte's `CS` numbering.

`assets/products.json` is a **snapshot**, so the store renders before the Apps
Script is deployed and still renders if the feed is ever down. Once
`CONFIG.FEED_URL` is set the live feed takes over. Refresh the snapshot with
`python3 scripts/build_seed_catalog.py`.

### Images are matched by name, and 13 products have none

The sheet's `Image URL` column is empty, so photos are matched to products by
filename against the
[Drive folder](https://drive.google.com/drive/folders/1Bt-GO4kah47SWFxs0vU7fUg82JWW9W7m).
Two signals, weighted by how rare each word is across the folder: shared
distinctive words, and compressed-name containment (this is the only thing
joining `fit-pack.jpg` to `Fitpack V2`). Generic words — `polo`, `tumbler`,
`black` — count for less and can never carry a match alone, and each file goes
to at most one product.

These nine are matched and correct:

| Product | File |
|---|---|
| ET-TU Metro Drifit polo - Black | `Metro-polo-.jpg` |
| ET-TU Galactic Drifit polo - Grey | `Galactic-Polo---Moss-Green-Heather-.jpg` |
| ET-TU Recycled Numa Hoodie - Black | `Numa-hoodie---Black-Heather-.jpg` |
| ET-TU Recycled Full zip classic hoodie - Black | `Classic-no-zip-hoodie---Black.jpg` |
| ET-TU Full Zip Swag Jacket - Black | `Swag-black.jpg` |
| ET-TU Vector Vest | `Vector-Vest-.jpg` |
| Fitpack V2 | `fit-pack.jpg` |
| Cascade Mug Alternative | `HydroMonk-Cascade---40-0z-Tumbler.jpg` |
| Cork Notebook | `cork.jpg` |

**Two of those need a human eye:**

* *Recycled Full zip classic hoodie* is wearing `Classic-no-zip-hoodie`. The
  filename says **no**-zip, the product is **full**-zip. Closest file in the
  folder, and no matcher can tell these apart from strings.
* *Galactic Drifit polo - Grey* is wearing `Moss-Green-Heather`. Right style,
  possibly the wrong colourway.

**Thirteen products have no photo in the folder at all:** ET-TU Summer Tech
Polo Women's, all eight travelXOXO bags (tote, trunk organiser, cabin harness,
Expedia sling, bottle carrier, Saba sling, sports sling, Basecamp duffle),
Transit backpack, Limited Edition Backpack, Himalayan Tumbler, OMG Twill Cap.
They render an "Image coming soon" placeholder.

Meanwhile **20 files in the folder match no product** — Adidas and ASICS tees
and jackets, journals, memo pads, `Crema-polo`, `BKC`, `Cooler`, `bonded`,
`Canvas-tote`, `Classic-Peaklayer-Quarter-zip`. Either they belong to products
missing from the sheet, or the 22 rows are only part of the intended range.
**Worth resolving before go-live.**

To audit the matching against the real photographs, run `reviewImageMatches()`
from the Apps Script editor: it writes an `ImageMatchReview` tab with every
product, the file chosen, the score, what it matched on and the runner-up.
Correct anything wrong by putting a URL in the sheet's own `Image URL` column —
that always beats the matcher — then `applyImageMatches()` makes the approved
ones permanent.

---

## Brand

Wells Fargo red, black, white and greys, per the client. Brand yellow is
deliberately unused: yellow-on-red is the stagecoach livery and reads as
consumer retail, not an internal catalogue.

| Token | Value | Use |
|---|---|---|
| `--brand` | `#D71E28` | primary actions, links, active states |
| `--brand-dark` | `#B01119` | hover / pressed |
| `--brand-deep` | `#8B0D14` | dark surfaces on red |
| `--ink` | `#000000` | body text, hero, dark surfaces |
| `--grey` | `#8C8C8C` | secondary text |
| `--off` | `#F5F5F5` | page and image backgrounds |
| `--tint` | `#FCEBEC` | callouts |
| `--line` | `#E0E0E0` | borders |

All of it lives in `:root` in `assets/css/app.css` and nowhere else. There are
no mail templates in this build; if one is added it will carry its own copy of
these values and both will need changing.

**The logo files are placeholders** cropped from the client's own banner
artwork. See `assets/brand/README.md` before go-live.

---

## Deploy

### 1. Backend

1. Open the catalogue sheet → **Extensions → Apps Script**.
2. Paste in `apps-script-feed/Code.gs`.
3. Check `CFG` at the top. `CATALOG_SHEET` must be the tab name (`Sheet1`) and
   `IMAGE_FOLDER_ID` the Drive folder id.
4. Run `healthCheck()` once and read the log. It reports the product count,
   how many have photos, names every product that has none, and fails loudly
   if any product somehow carries a price.
5. Run `reviewImageMatches()` and check the `ImageMatchReview` tab.
6. **Share the Drive image folder as "Anyone with the link — Viewer."**
   Without this the thumbnails are broken for everyone but you.
7. **Deploy → New deployment → Web app.** Execute as **Me**, access
   **Anyone**. Copy the `/exec` URL.

Redeploying later: **Deploy → Manage deployments → pencil icon → Version: New
version → Deploy.** This keeps the same URL, so the site needs no change.

### 2. Frontend

1. Paste the `/exec` URL into `CONFIG.FEED_URL` at the top of
   `assets/js/app.js`. It is empty until you do, and the store runs on the
   bundled snapshot.
2. Commit and push; **Settings → Pages → Source: `main`, folder `/ (root)`.**

There is no `API_TOKEN`, `PEPPER`, `ADMIN_PASS` or `SENDER_ALIAS` to set. This
store has no login, no approval flow and no mail — those belong to the
full-commerce build, not this one. `CFG.TOKEN` in `Code.gs` is an optional
shared secret and is off by default.

---

## Requests

Submitting the cart POSTs `{fn:'kit_request', ...}` and appends one row to a
**Wells Fargo Kit Requests** tab, created on demand. Timestamp, name, work
email, notes, an item summary, the total quantity and the raw JSON. No login,
no approval, no payment.

Apps Script cannot answer a CORS preflight, so every POST goes out as
`Content-Type: text/plain` with a JSON string body. Do not "fix" this to
`application/json` — every write will start failing.

---

## What changed from Deloitte

Rebuilt, not inherited:

1. **All pricing removed** at the feed, per the client. See above.
2. **New palette** in `assets/css/app.css`; new hero and wordmark in
   `assets/brand/`.
3. **New catalogue.** None of Deloitte's products carried over.
4. **Fresh SKU sequence** `WF0001`, not Deloitte's `CS` numbering.
5. **New Apps Script.** Single-brand (the old one served Optum and Deloitte
   off one sheet via `?brand=`), reads `Sheet1`, and adds the Drive image
   matcher, which is new — the Deloitte script read a pre-filled `Image URL`
   column.
6. **`assets/taxonomy.json` emptied.** It was keyed to Deloitte `CS####` SKUs
   and would have silently matched nothing against `WF####`.
7. **`assets/colorways.json` emptied.** Deloitte's groups named Deloitte SKUs.

Removed rather than carried over:

8. **`kit.html` and `preset-kits.html`, and the kit-building engine.** Every
   decision it made was a budget comparison — "which products fit ₹X per
   head". With no prices it has nothing to optimise against and would only
   ever return empty kits. Kits for Wells Fargo need either real prices or a
   different rule, not this code with the money taken out.
9. **Dead nav code** (`flyoutNavItem`, `EVENT_KIT_NAV`, `GIFTING_NAV`).
   Defined but never called, and every link pointed at `event-kits.html`,
   a page that does not exist in this project or in the one it came from.
10. **Stale README.** Deloitte's described a login/checkout/admin/approval
    system with 134 products and HMAC-signed approver links. None of that was
    in the code. This file describes what is actually here.

Also fixed while porting: the classifier now judges on the **product name**
first and only falls back to the description. Descriptions list what a product
holds, and that is not what it is — judged on both together, "Bottle Carrier
Bag" filed itself under Drinkware, "Sports Sling" became a mug (an elastic cup
holder), and the "Cabin Luggage Harness & Backpack" became a trolley bag.

---

## Still open

1. **Photos for 13 of 22 products**, and an explanation for the 20 unmatched
   files in the Drive folder. The biggest gap.
2. **The full-zip / no-zip hoodie photo** and the Galactic polo colourway.
3. **Official Wells Fargo vector logo artwork** to replace the banner crops.
4. Confirmation that 22 rows is the whole catalogue — the Drive folder's
   contents suggest more products were intended.
5. Who receives the Kit Requests, and whether they should be emailed rather
   than left in a tab.
