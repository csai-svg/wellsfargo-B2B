/*
  WELLS FARGO B2B view-only catalogue — Apps Script Web App, bound to the
  "Copy of Wells Fargo New Catalog - 2026-27" spreadsheet.

  Does THREE things and nothing else:

    doGet(?fn=catalog)   -> live JSON of only the public columns (name, brand,
                            description, gender, category, image). Cost Price,
                            Margins and EVERY price band are NEVER read into
                            the response — see "NO PRICING" below.
    doGet(?fn=images)    -> the resolved product-name -> Drive-image map, for
                            eyeballing the matcher without opening the sheet.
    doPost {fn:'kit_request', ...} -> appends one row to "Wells Fargo Kit
                            Requests" (created on demand) so the team sees
                            cart submissions. No login, no approval, no payment.

  ------------------------------------------------------------------
  NO PRICING. Deliberate, not an oversight.
  ------------------------------------------------------------------
  Wells Fargo's store shows no prices at all. This script does not blank the
  price fields after reading them — it never reads the Cost Price, Margin,
  MOQ or any of the five B2B band columns in the first place. Every product
  goes out with `tiers: []`, `base_price: 0` and `moq: 0`.

  That is enough for the frontend to hide everything money-shaped on its own:
  assets/js/app.js has hasPrice(), which is false when the lowest price is 0,
  and the product page, the cart and the card grid all gate on it already.

  Reading-then-blanking would have put real cost and margin figures into a
  public JSON response one refactor away from leaking. Not reading them means
  the master sheet can keep its commercials and there is nothing to leak.
  If prices are ever wanted, that is a change here AND a change in app.css /
  the templates — do not "fix" it by re-adding the columns alone.

  ------------------------------------------------------------------
  IMAGES come from a Drive folder, matched on product name.
  ------------------------------------------------------------------
  The sheet's "Image URL" column is empty. Images live in CFG.IMAGE_FOLDER_ID
  and are matched to products by filename, because that is the only thing
  the two sides share. See resolveImages_() for the scoring rules.

  The matcher is a guess, so it is auditable rather than silent:
    - reviewImageMatches()  writes every product, its chosen file, the score
                            and the runner-up to an "ImageMatchReview" tab.
    - applyImageMatches()   writes the approved rows' URLs into the sheet's
                            "Image URL" column, making them permanent.
    - A non-empty "Image URL" cell ALWAYS wins over the matcher. Once a row is
      filled in by hand or by applyImageMatches(), the guesswork stops for it.

  The Drive folder must be shared "Anyone with the link — Viewer", or the
  thumbnails render as broken images for everyone but you.

  ------------------------------------------------------------------
  Deploy (once): Extensions > Apps Script (from the catalogue sheet) > paste
  this > Deploy > New deployment > Web app > Execute as: Me > Who has access:
  Anyone > copy the /exec URL into CONFIG.FEED_URL in assets/js/app.js.

  Redeploying after an edit: Deploy > Manage deployments > pencil icon >
  Version: New version > Deploy. This keeps the same /exec URL, so the site
  needs no change.
*/

var CFG = {
  BRAND: 'Wells Fargo',
  CATALOG_SHEET: 'Sheet1',                                  // tab name of the catalogue
  IMAGE_FOLDER_ID: '1Bt-GO4kah47SWFxs0vU7fUg82JWW9W7m',     // Drive folder of product photos
  SKU_PREFIX: 'WF',                                         // fresh sequence, not Deloitte's CS
  TOKEN: '',                                                // optional shared secret; '' = open
  CACHE_SECS: 300,
  IMAGE_MIN_SCORE: 1.6,   // below this the match is too weak to use; product ships imageless
};

var REVIEW_SHEET = 'ImageMatchReview';

/* Header-name -> column finder (tolerant: trims, lowercases, collapses runs of
   whitespace). Falls back to a prefix match when nothing matches exactly, so a
   header cell with extra explanatory text tacked on still resolves — this
   sheet's name column is literally "Product name\n( Brand+Product Name+
   Colour)". A blank match there would empty every row's name and the whole
   catalogue would silently disappear, which is far worse than tolerating a
   decorated header. */
function colMap_(header) {
  var m = {};
  header.forEach(function (h, i) { m[String(h).toLowerCase().replace(/\s+/g, ' ').trim()] = i; });
  var keys = Object.keys(m);
  return function (name) {
    var k = name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (k in m) return m[k];
    for (var i = 0; i < keys.length; i++) if (keys[i].indexOf(k) === 0) return m[keys[i]];
    return -1;
  };
}

/* The sheet was exported from a system that left literal "&#13;" (an HTML
   carriage-return entity) inside several product names and descriptions —
   "travelXOXO Saba Sling&#13;". Left alone it renders as visible junk on the
   card. Stripped here rather than in the sheet so re-exports stay safe. */
function clean_(v) {
  return String(v == null ? '' : v)
    .replace(/&#13;?/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function colors_(desc) {
  var m = /(?:available in|colou?rs?\s*variants?|colou?rs?\s*available|available colou?rs?)\s*[:\-]?\s*([^.]+)/i.exec(desc || '');
  if (!m) return [];
  return m[1].split(/,| and /).map(function (s) { return s.trim().replace(/\.$/, ''); })
    .filter(function (s) { return s && s.length < 30; }).slice(0, 12);
}

/* ------------------------------------------------------------------
   classify_(): assigns BOTH a top-level category and a real sub-category
   from the product name + description. Ordered rules, first match wins.
   ------------------------------------------------------------------ */
var NEUTRALIZE = [
  /bottle (pocket|pockets|holder|holders|sleeve|compartment|cage|opener)/g,
  /(screw|flip|flip-top|flip top|leak-?proof|spill-?proof|stylish|sipper|push-?button|press|one-press|twist|sliding|as sliding) (lid|cap)/g,
  /bottle cap/g,
  /pen (loop|loops|holder|pocket|slot)/g,
  /shoe (pouch|pocket|compartment|bag)/g,
  /(luggage|trolley) (mount|strap|straps|sleeve|pass-?through|pass|tag|handle)/g,
  /bottle green/g,
  /water bottle pocket/g,
  /* An elastic cup holder is a pocket, not a cup — this is what put
     "travelXOXO Sports Sling" in Mugs & tumblers. */
  /cup ?holders?/g,
  /* "Cabin Luggage Harness & Backpack" is a backpack; left alone the
     cabin/luggage rule files it as a trolley bag. */
  /cabin luggage/g,
  /luggage harness/g
];
var RULES = [
  [/gift box/, 'Gift Box', 'Gift Box'],
  [/lunch ?box/, 'Utilities', 'Accessories'],
  /* Before the bottle rule: a carrier is the bag, not what goes in it. */
  [/carrier bag|bottle carrier/, 'Travel', 'Travel accessories'],
  [/\bbottle|\bflask|\bsipper|sports bottle|\bthermos\b|insulated (bottle|flask)/, 'Drinkware', 'Bottles'],
  [/\bcap\b|\bcaps\b|beanie|bucket hat|\bvisor\b/, 'Apparel', 'Headwear'],
  [/hoodie|sweat ?shirt|half-?zip|quarter-?zip|hooded/, 'Apparel', 'Hoodies'],
  [/\bvest\b|\bjacket|\bpuffer|\bfleece|\bbomber|track top|track jacket|track suit|tracksuit|windcheater|\bgilet/, 'Apparel', 'Jackets'],
  [/\bpolo|t-?shirt|\bt shirt|\btee\b|round neck|round-neck|crew neck|henley/, 'Apparel', 'T-Shirts'],
  [/formal shirt|dress shirt|\bshirt/, 'Apparel', 'Shirts'],
  [/\bshoes\b|sneaker|running shoes|sports shoes|footwear/, 'Apparel', 'Footwear'],
  [/sound ?bar|\bspeaker|earbud|ear ?phone|head ?phone|neckband|smart ?watch|\bear ?buds?\b/, 'Tech', 'Audio & Wearables'],
  [/power ?bank|wireless charg|charging (station|dock|cable)|multi-?charging|\bcharger\b|\badapter\b|charging cable/, 'Tech', 'Power & Charging'],
  [/air ?fryer|\bkettle\b|induction|cook ?top|\bblender|\bjuicer|\bgrinder|garment steamer|\bsteamer\b|vacuum cleaner|\bmixer|hand fan|\bmop\b/, 'Tech', 'Appliances'],
  [/tumbler|travel mug|coffee mug|ceramic (mug|cup)|\bmug\b|\bmugs\b|\bcup\b/, 'Drinkware', 'Mugs & tumblers'],
  [/trolley|suit ?case|luggage|\bcabin\b|polycarbonate|polypropylene|hard ?top|hard-?shell|hard-?sided|travel gear|spinner wheel|telescopic/, 'Travel', 'Trolley bags'],
  [/laptop backpack|\bbackpack\b|back pack|rucksack|daypack|\bfitpack\b/, 'Travel', 'Backpack'],
  [/\bduffle|\bduffel|weekender|gym bag/, 'Travel', 'Duffle bag'],
  [/\btote\b|\bjute\b|cotton tote|shopper|shopping bag/, 'Travel', 'Tote bags'],
  [/laptop sleeve|laptop bag|\bmessenger|\bsling|crossbody|work folio|\bfolio\b|file case|briefcase/, 'Travel', 'Laptop handbag'],
  [/passport|dopp kit|toiletry|toiletary|neck pillow|travel set|lunch bag|packing|organiser|organizer|carrier bag|cooler/, 'Travel', 'Travel accessories'],
  [/\bcoaster/, 'Utilities', 'Coasters'],
  [/twist-mechanism pen|ball ?point|roller ?ball|stylus pen|\bpen\b(?! ?(loop|holder|stand|pocket|slot))|\bpens\b/, 'Utilities', 'Pens'],
  [/note ?book|\bdiary\b|journal|notepad|memo ?pad|organizer diary/, 'Utilities', 'Notebook'],
  [/wallet|key ?chain|card holder|\bpouch|organiz|\bstand\b|desk|tech organizer/, 'Utilities', 'Accessories']
];

function scrub_(s) {
  var t = String(s || '').toLowerCase();
  for (var k = 0; k < NEUTRALIZE.length; k++) t = t.replace(NEUTRALIZE[k], ' ');
  return t;
}

/* The NAME decides, and the description is only consulted when the name says
   nothing a rule recognises.

   Descriptions list what a product holds, and that is not what it is. Judged
   on name+description together, "travelXOXO Bottle Carrier Bag" became
   Drinkware (its blurb mentions bottles up to 60 oz), "Sports Sling" became a
   mug (an elastic cup holder) and the "Cabin Luggage Harness & Backpack"
   became a trolley bag (it attaches to cabin suitcases). All three are right
   on the name alone. The description still earns its place on rows like
   "Transit backpack", where the name is too thin to place on its own. */
function classify_(name, brand, desc) {
  if (String(name).toLowerCase().indexOf('gift box') >= 0) return ['Gift Box', 'Gift Box'];
  var byName = scrub_(name + ' ' + brand);
  for (var i = 0; i < RULES.length; i++) {
    if (RULES[i][0].test(byName)) return [RULES[i][1], RULES[i][2]];
  }
  var byAll = scrub_(name + ' ' + brand + ' ' + desc);
  for (var j = 0; j < RULES.length; j++) {
    if (RULES[j][0].test(byAll)) return [RULES[j][1], RULES[j][2]];
  }
  return ['Utilities', 'Accessories'];
}

/* ==================================================================
   IMAGE MATCHING
   ==================================================================
   The sheet and the Drive folder share nothing but words in a name:
   "ET-TU Metro Drifit polo - Black" has to find "Metro-polo-.jpg".

   Two independent signals, because either alone gets it wrong:

   1. Weighted token overlap. Both sides are lowercased and split on
      non-alphanumerics. Each shared token scores its inverse document
      frequency across the folder, so "metro" (one file) is worth far more
      than "polo" (four files) and colour words like "black" barely count.
      A plain count would tie "Metro polo" with "Crema polo" on the token
      "polo" and pick whichever came first.

   2. Compressed-substring containment. Separators are dropped entirely and
      one side is tested for containment in the other, which is the only
      thing that joins "fit-pack.jpg" to "Fitpack V2" — as tokens those
      share nothing at all.

   Anything scoring under CFG.IMAGE_MIN_SCORE ships with no image rather than
   a wrong one. A product with no photo is a gap someone will fill; a product
   wearing another product's photo is a wrong order.
*/

/* Words that appear in so many names they carry no evidence, plus file-side
   noise from the export ("front", "a"/"b"/"w" suffixes are handled by the
   length filter below). Colour words are NOT listed: they are weak by IDF
   already, and "Swag-black" genuinely needs "swag" + a nudge from "black". */
var STOP = {
  the: 1, and: 1, with: 1, for: 1, of: 1, in: 1, a: 1, an: 1, to: 1,
  ltr: 1, oz: 1, cm: 1, na: 1, alternative: 1, new: 1, copy: 1, final: 1,
  img: 1, image: 1, photo: 1, mockup: 1, front: 1, back: 1, side: 1, jpg: 1, png: 1
};

/* Generic category nouns and colour words. These are real evidence — "polo"
   does rule out the notebooks — but they identify a CATEGORY, not an ITEM, so
   they are worth 0.6 of a distinctive token and can never carry a match on
   their own (see the `strong` gate in scoreMatch_).

   Measured against the real data, this is what separates a right answer from
   a plausible one. Without it "ET-TU Summer Tech Polo Women's" matched an
   ASICS polo photo on the single word "polo", and the one HydroMonk tumbler
   photo was claimed by "Himalayan Tumbler" (on "tumbler") ahead of its actual
   owner "Cascade Mug" (on "cascade"). With it, both of those correctly fall
   through to no image and the nine surviving matches are all right. */
var GENERIC = {
  tumbler: 1, mug: 1, cup: 1, bottle: 1, flask: 1, polo: 1, shirt: 1, tee: 1,
  hoodie: 1, jacket: 1, vest: 1, cap: 1, tote: 1, bag: 1, backpack: 1, sling: 1,
  duffle: 1, duffel: 1, notebook: 1, journal: 1, pad: 1, memo: 1, pen: 1,
  cooler: 1, organiser: 1, organizer: 1, harness: 1, luggage: 1, pack: 1,
  zip: 1, classic: 1, solid: 1, ladies: 1, women: 1, mens: 1, men: 1,
  black: 1, white: 1, grey: 1, gray: 1, red: 1, blue: 1, green: 1, heather: 1
};

function tokens_(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&#13;?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(function (t) { return t.length > 1 && !STOP[t]; });
}

function compress_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/* Lists the image folder once and precomputes each file's tokens, its
   compressed name and the folder-wide token frequencies used for IDF. */
function imageIndex_() {
  var folder = DriveApp.getFolderById(CFG.IMAGE_FOLDER_ID);
  var it = folder.getFiles();
  var files = [], df = {};
  while (it.hasNext()) {
    var f = it.next();
    var mime = f.getMimeType();
    if (mime.indexOf('image/') !== 0) continue;
    var base = f.getName().replace(/\.[a-z0-9]+$/i, '');
    var toks = tokens_(base);
    var uniq = {};
    toks.forEach(function (t) { uniq[t] = 1; });
    Object.keys(uniq).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    files.push({
      id: f.getId(),
      name: f.getName(),
      tokens: Object.keys(uniq),
      compressed: compress_(base),
      url: 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w1000',
    });
  }
  return { files: files, df: df, n: files.length };
}

/* Scores one product name against one indexed file. `strong` is the gate that
   decides whether the score is admissible at all. */
function scoreMatch_(prodTokens, prodCompressed, file, idx) {
  var score = 0, hits = [], n = 0, distinctive = false, contained = false;
  var seen = {};
  for (var i = 0; i < prodTokens.length; i++) {
    var t = prodTokens[i];
    if (seen[t]) continue;
    seen[t] = 1;
    if (file.tokens.indexOf(t) < 0) continue;
    /* Classic IDF: a token in 1 of 30 files is decisive, a token in 15 of 30
       is nearly worthless. +1 inside the log keeps a token present in every
       single file at a score of 0 rather than negative. */
    var weight = GENERIC[t] ? 0.6 : 1;
    score += weight * Math.log(1 + idx.n / (idx.df[t] || 1));
    hits.push(GENERIC[t] ? t + '*' : t);   // the * marks a generic token in the review tab
    n++;
    if (!GENERIC[t] && (idx.df[t] || 0) === 1) distinctive = true;
  }
  /* Containment either way: the file name is often a shorthand of the product
     name ("fit-pack" inside "fitpackv2"), and occasionally the reverse. Only
     counted for stems long enough to be meaningful — "cork" yes, "v2" no. */
  if (file.compressed.length >= 5 && prodCompressed.indexOf(file.compressed) >= 0) {
    score += 2.5; hits.push('~' + file.compressed); contained = true;
  } else if (prodCompressed.length >= 5 && file.compressed.indexOf(prodCompressed) >= 0) {
    score += 2.0; hits.push('~' + prodCompressed); contained = true;
  }

  /* Admissible only if the evidence is more than one generic word: either the
     names overlap as strings, or two separate tokens agree, or one token is a
     distinctive word unique to this single file ("cascade", "cork", "numa"). */
  var strong = contained || n >= 2 || distinctive;
  return { score: score, hits: hits, n: n, strong: strong };
}

/* Best file per product name, with each file going to at most ONE product.

   The second pass matters: the folder holds a single HydroMonk photo and two
   HydroMonk drinkware rows both reach for it. Letting both have it would put
   the wrong picture on a product — the failure mode nobody notices until an
   order is wrong. So a file is awarded to its highest-scoring claimant and
   every other claimant is left imageless and reported as CONTESTED.

   Returns { name -> {url, file, score, hits, runnerUp, runnerUpScore,
   lostTo} } for every product, matched or not. */
function resolveImages_(names) {
  var idx = imageIndex_();

  var claims = names.map(function (name) {
    var pt = tokens_(name), pc = compress_(name);
    var best = null, second = null;
    idx.files.forEach(function (f) {
      var s = scoreMatch_(pt, pc, f, idx);
      if (!s.strong || s.score < CFG.IMAGE_MIN_SCORE) return;
      var cand = { file: f, score: s.score, hits: s.hits, n: s.n };
      if (!best || cand.score > best.score) { second = best; best = cand; }
      else if (!second || cand.score > second.score) { second = cand; }
    });
    return { name: name, best: best, second: second };
  });

  /* Award each file to its strongest claimant; more matched tokens breaks a
     score tie, and failing that the earlier row keeps it, so the outcome is
     stable across runs rather than depending on folder listing order. */
  var owner = {};
  claims.forEach(function (c) {
    if (!c.best) return;
    var k = c.best.file.name, cur = owner[k];
    if (!cur || c.best.score > cur.best.score ||
        (c.best.score === cur.best.score && c.best.n > cur.best.n)) owner[k] = c;
  });

  var out = {};
  claims.forEach(function (c) {
    var won = c.best && owner[c.best.file.name] === c;
    out[c.name] = {
      url: won ? c.best.file.url : '',
      file: won ? c.best.file.name : '',
      score: c.best ? Math.round(c.best.score * 100) / 100 : 0,
      hits: c.best ? c.best.hits.join(' ') : '',
      runnerUp: c.second ? c.second.file.name : '',
      runnerUpScore: c.second ? Math.round(c.second.score * 100) / 100 : 0,
      lostTo: (c.best && !won) ? (c.best.file.name + ' -> ' + owner[c.best.file.name].name) : '',
    };
  });
  return out;
}

/* ------------------------------------------------------------------ catalog */

function buildCatalog_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG.CATALOG_SHEET) || ss.getSheets()[0];
  var vals = sh.getDataRange().getValues();
  var header = vals[0], C = colMap_(header);

  /* Only these columns are read. Cost Price, MOQ, Margin and the five B2B
     price bands are intentionally absent — see the NO PRICING note at the
     top of this file before adding any of them back. */
  var ci = {
    name: C('product name'), brand: C('brand'), desc: C('description'),
    gender: C('style(gender)'), sr: C('sr no'), img: C('image url'),
    lead: C('leadtime for moq'), parentSku: C('sku codes - parent'),
    topSelling: C('top selling'), sustainable: C('sustainable'),
  };
  if (ci.name < 0) throw new Error('buildCatalog_: no "Product name" column in "' + CFG.CATALOG_SHEET + '"');

  var yes_ = function (v) { return /^\s*(y|yes|true|1)\s*$/i.test(String(v || '')); };

  /* Pass one: read the rows. */
  var rows = [], needImage = [];
  for (var r = 1; r < vals.length; r++) {
    var row = vals[r];
    var name = clean_(row[ci.name]);
    if (!name) continue;
    var sheetImg = ci.img >= 0 ? clean_(row[ci.img]) : '';
    if (!sheetImg) needImage.push(name);
    rows.push({ row: row, r: r, name: name, sheetImg: sheetImg });
  }

  /* Pass two: one Drive listing for the whole catalogue, not one per row.
     A failure here must not take the catalogue down — an imageless store is
     still a usable store, a 500 is not. */
  var matched = {};
  if (needImage.length) {
    try { matched = resolveImages_(needImage); }
    catch (err) { Logger.log('image match failed, serving without images: ' + err); }
  }

  var products = rows.map(function (rec) {
    var row = rec.row;
    var sr = String(row[ci.sr] || rec.r).replace(/[^0-9]/g, '') || String(rec.r);
    var sku = CFG.SKU_PREFIX + ('0000' + sr).slice(-4);
    var itemBrand = clean_(row[ci.brand]);
    var desc = clean_(row[ci.desc]);
    var cls = classify_(rec.name, itemBrand, desc);
    var m = matched[rec.name];

    return {
      sku: sku,
      name: rec.name,
      category: cls[0],
      subcategory: cls[1],
      brand: itemBrand,
      description: desc,
      gender: (function (g) { return /^na$/i.test(g) ? '' : g; })(clean_(row[ci.gender])),
      colors: colors_(desc),
      lead_time: ci.lead >= 0 ? clean_(row[ci.lead]) : '',

      /* Price-shaped fields, all deliberately empty. hasPrice() in app.js
         reads base_price/tiers and hides every money element when they are
         zero — this is what makes the storefront priceless, not CSS. */
      moq: 0, gst_rate: 0, tiers: [], base_price: 0,

      sizes: ['OS'], has_sizes: false,
      image: rec.sheetImg || (m ? m.url : ''),
      image_source: rec.sheetImg ? 'sheet' : (m && m.url ? 'drive-match' : 'none'),
      active: true, related: [],
      event_tags: cls[0] === 'Gift Box' ? ['kit'] : [],
      top_selling: ci.topSelling >= 0 ? yes_(row[ci.topSelling]) : false,
      sustainable: ci.sustainable >= 0 ? yes_(row[ci.sustainable]) : /sustainab|recycled|eco-?friendly|rpet/i.test(desc),
      parent_sku: ci.parentSku >= 0 ? clean_(row[ci.parentSku]) : '',
    };
  });

  /* Only advertise categories that actually have something in them, so the
     home page never renders an empty tile. */
  var present = {};
  products.forEach(function (p) { present[p.category] = 1; });
  var categories = ['Apparel', 'Drinkware', 'Travel', 'Tech', 'Utilities', 'Gift Box']
    .filter(function (c) { return present[c]; });

  return {
    generated_at: new Date().toISOString(),
    brand: CFG.BRAND,
    pricing: 'hidden',          // explicit, so a consumer never mistakes 0 for free
    categories: categories,
    products: products,
    event_kits: products.filter(function (p) { return p.category === 'Gift Box'; })
      .map(function (p) { return p.sku; }),
  };
}

function jsonOut_(obj, cb) {
  var s = JSON.stringify(obj);
  if (cb) return ContentService.createTextOutput(cb + '(' + s + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (CFG.TOKEN && p.token !== CFG.TOKEN) return jsonOut_({ error: 'unauthorized' }, p.callback);

  if (p.fn === 'images') {
    var sh = SpreadsheetApp.getActive().getSheetByName(CFG.CATALOG_SHEET);
    var vals = sh.getDataRange().getValues();
    var C = colMap_(vals[0]), nameCol = C('product name');
    var names = vals.slice(1).map(function (r) { return clean_(r[nameCol]); }).filter(String);
    return jsonOut_({ folder: CFG.IMAGE_FOLDER_ID, matches: resolveImages_(names) }, p.callback);
  }

  var cache = CacheService.getScriptCache();
  var hit = cache.get('catalog');
  if (hit && !p.nocache) return jsonOut_(JSON.parse(hit), p.callback);
  var data = buildCatalog_();
  /* Silently skipped when the payload exceeds the 100KB cache ceiling; the
     feed just rebuilds each time, which at this catalogue size is fine. */
  try { cache.put('catalog', JSON.stringify(data), CFG.CACHE_SECS); } catch (err) {}
  return jsonOut_(data, p.callback);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return jsonOut_({ ok: false, error: 'bad json' }); }
  if (CFG.TOKEN && body.token !== CFG.TOKEN) return jsonOut_({ ok: false, error: 'unauthorized' });
  if (body.fn !== 'kit_request') return jsonOut_({ ok: false, error: 'unknown fn' });

  var tabName = CFG.BRAND + ' Kit Requests';
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(tabName);
  if (!sh) {
    sh = ss.insertSheet(tabName);
    sh.appendRow(['Timestamp', 'Name', 'Work email', 'Notes / deadline', 'Items (summary)', 'Total qty', 'Items (JSON)']);
    sh.setFrozenRows(1);
  }
  var items = body.items || [];
  var summary = items.map(function (it) { return it.qty + ' x ' + it.name + (it.sku ? ' [' + it.sku + ']' : ''); }).join('; ');
  var totalQty = items.reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
  sh.appendRow([new Date(), body.name || '', body.email || '', body.notes || '', summary, totalQty, JSON.stringify(items)]);
  return jsonOut_({ ok: true });
}

/* ==================================================================
   MAINTENANCE — run by hand from the Apps Script editor, never by the web app
   ================================================================== */

/* Writes what the matcher decided to an "ImageMatchReview" tab so it can be
   checked against the actual photographs before anything is committed to the
   catalogue. Re-run any time; the tab is rebuilt from scratch.

   Read the Decision column:
     MATCHED    confident, will be used by the live feed as-is
     WEAK       no admissible candidate, ships with NO image
     CONTESTED  wanted a file that another product had a stronger claim on;
                ships with NO image. The "Lost to" column names the winner.
     IN SHEET   the row already has an Image URL; the matcher was not consulted

   A * after a token in "Matched on" means it is a generic word (a colour or a
   category noun), so a row whose only evidence is starred is the weakest kind
   of match even when it passed — look at those first.

   To correct one: put the right URL in the sheet's own "Image URL" column
   (it always wins), or fix the file name in Drive and re-run. */
function reviewImageMatches() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG.CATALOG_SHEET) || ss.getSheets()[0];
  var vals = sh.getDataRange().getValues();
  var C = colMap_(vals[0]);
  var nameCol = C('product name'), imgCol = C('image url');

  var rows = [];
  for (var r = 1; r < vals.length; r++) {
    var name = clean_(vals[r][nameCol]);
    if (!name) continue;
    rows.push({ r: r + 1, name: name, existing: imgCol >= 0 ? clean_(vals[r][imgCol]) : '' });
  }
  var matches = resolveImages_(rows.map(function (x) { return x.name; }));

  var out = [['Decision', 'Row', 'Product name', 'Matched file', 'Score', 'Matched on',
              'Runner-up', 'Runner-up score', 'Lost to', 'New URL']];
  var used = {}, weak = 0, ok = 0, contested = 0;
  rows.forEach(function (x) {
    var m = matches[x.name] || {};
    var decision = x.existing ? 'IN SHEET'
      : (m.url ? 'MATCHED' : (m.lostTo ? 'CONTESTED' : 'WEAK'));
    if (decision === 'MATCHED') { ok++; used[m.file] = 1; }
    else if (decision === 'CONTESTED') contested++;
    else if (decision === 'WEAK') weak++;
    out.push([decision, x.r, x.name, m.file || '', m.score || 0, m.hits || '',
              m.runnerUp || '', m.runnerUpScore || 0, m.lostTo || '', m.url || '']);
  });

  /* Photos in the folder that no product claimed. Usually a product missing
     from the sheet, or a file named nothing like its product — either way a
     gap worth seeing next to the products that came up with no image. */
  var idx = imageIndex_();
  var orphans = idx.files.filter(function (f) { return !used[f.name]; }).map(function (f) { return f.name; });
  if (orphans.length) {
    out.push([]);
    out.push(['UNUSED', '', orphans.length + ' file(s) in the Drive folder matched no product:',
              orphans.join(', ')]);
  }

  var rv = ss.getSheetByName(REVIEW_SHEET);
  if (rv) rv.clear(); else rv = ss.insertSheet(REVIEW_SHEET);
  /* Ragged rows (the DUPLICATE/UNUSED footers are short) cannot go through a
     single setValues, so they are padded to the header width. */
  var w = out[0].length;
  var padded = out.map(function (row) {
    var copy = row.slice();
    while (copy.length < w) copy.push('');
    return copy;
  });
  rv.getRange(1, 1, padded.length, w).setValues(padded);
  rv.setFrozenRows(1);

  var msg = 'reviewImageMatches: ' + ok + ' matched, ' + weak + ' too weak, ' +
    contested + ' contested, ' + orphans.length + ' unused file(s). ' +
    'Open "' + REVIEW_SHEET + '" and check the MATCHED rows against the photos.';
  Logger.log(msg);
  return msg;
}

/* Commits the review tab's MATCHED rows into the catalogue's "Image URL"
   column, which makes them permanent and stops the matcher guessing for those
   products on every request. Run reviewImageMatches() first and CHECK IT —
   this writes to the catalogue sheet.

   Only writes rows whose Decision is still MATCHED and whose Image URL cell
   is empty, so it can never overwrite a URL someone put in by hand. Safe to
   re-run. */
function applyImageMatches() {
  var ss = SpreadsheetApp.getActive();
  var rv = ss.getSheetByName(REVIEW_SHEET);
  if (!rv) throw new Error('applyImageMatches: no "' + REVIEW_SHEET + '" tab — run reviewImageMatches() first');
  var rvals = rv.getDataRange().getValues();
  var RC = colMap_(rvals[0]);
  var rci = { decision: RC('decision'), row: RC('row'), url: RC('new url') };
  if (rci.decision < 0 || rci.row < 0 || rci.url < 0) {
    throw new Error('applyImageMatches: "' + REVIEW_SHEET + '" is missing Decision/Row/New URL columns');
  }

  var sh = ss.getSheetByName(CFG.CATALOG_SHEET) || ss.getSheets()[0];
  var C = colMap_(sh.getDataRange().getValues()[0]);
  var imgCol = C('image url');
  if (imgCol < 0) throw new Error('applyImageMatches: no "Image URL" column in "' + CFG.CATALOG_SHEET + '"');

  var wrote = 0, skipped = 0;
  for (var i = 1; i < rvals.length; i++) {
    if (String(rvals[i][rci.decision] || '').trim().toUpperCase() !== 'MATCHED') continue;
    var sheetRow = parseInt(rvals[i][rci.row], 10);
    var url = String(rvals[i][rci.url] || '').trim();
    if (!sheetRow || !url) { skipped++; continue; }
    var cell = sh.getRange(sheetRow, imgCol + 1);
    if (String(cell.getValue() || '').trim()) { skipped++; continue; }  // never clobber a manual URL
    cell.setValue(url);
    wrote++;
  }
  CacheService.getScriptCache().remove('catalog');
  var msg = 'applyImageMatches: wrote ' + wrote + ' Image URL cell(s), skipped ' + skipped + '.';
  Logger.log(msg);
  return msg;
}

/* Reads back what the live feed would actually serve, without deploying or
   opening a browser. Names anything a visitor would notice. */
function healthCheck() {
  var d = buildCatalog_();
  var noImage = d.products.filter(function (p) { return !p.image; });
  var priced = d.products.filter(function (p) { return p.base_price || (p.tiers || []).length; });
  var lines = [
    'products: ' + d.products.length,
    'categories: ' + d.categories.join(', '),
    'from the sheet\'s Image URL column: ' + d.products.filter(function (p) { return p.image_source === 'sheet'; }).length,
    'auto-matched from Drive: ' + d.products.filter(function (p) { return p.image_source === 'drive-match'; }).length,
    'NO IMAGE (' + noImage.length + '): ' + (noImage.map(function (p) { return p.name; }).join(' | ') || 'none'),
    priced.length
      ? '*** ' + priced.length + ' product(s) carry a price — this store is meant to be priceless, check buildCatalog_ ***'
      : 'pricing: correctly absent on all products',
  ];
  var msg = lines.join('\n');
  Logger.log(msg);
  return msg;
}
