#!/usr/bin/env python3
"""Builds assets/products.json — the bundled catalogue snapshot.

The snapshot exists so the storefront renders before the Apps Script feed is
deployed, and still renders if the feed is ever slow or down. Once
CONFIG.FEED_URL is set in assets/js/app.js the live feed takes over and this
file is only the cold-start fallback.

Source of truth is the Wells Fargo catalogue sheet:
  https://docs.google.com/spreadsheets/d/1oy_PrlNb4tOH48eOKJBBYaJAEZ0h2FBwWDlcsQwAgjE

The rows below were transcribed from it on 2026-09-25. They are NOT the
long-term source — apps-script-feed/Code.gs reads the sheet directly. Re-run
this only to refresh the fallback; do not treat it as the catalogue.

NO PRICES. Every product ships moq 0, gst_rate 0, tiers [] and base_price 0,
matching what Code.gs serves. See the header of that file for why.
"""
import json, re, os

SHEET = "1oy_PrlNb4tOH48eOKJBBYaJAEZ0h2FBwWDlcsQwAgjE"

# Image IDs verified against the Drive folder on 2026-09-25. Only the matches
# the name-matcher in Code.gs makes confidently are listed; the other 13
# products have no usable photo in the folder yet and render the
# "Image coming soon" placeholder.
IMG = {
    "ET-TU Metro Drifit polo - Black":                "1U0MFSnATFfUjB-iEQ3qhwm0IGRzz6JMa",
    "ET-TU Galactic Drifit polo - Grey":              "1XC0p-eoOWZEFLKzzQzqNXupwHrvKEXnu",
    "ET-TU Recycled Numa Hoodie - Black":             "1YFxOsTrNSW27szEXb6H7FBKSFYlvxdEP",
    "ET-TU Recycled Full zip classic hoodie - Black": "1Jq3s4-nuuvFJa02sC7b1X4ErqVaTZpKX",
    "ET-TU Full Zip Swag Jacket - Black":             "1gmJF62XoPj0GBUQ_OZQixiwI6Bw_Umai",
    "ET-TU Vector Vest":                              "1Qgwq2zhZSEMz3yqqK69m2uSs3EKRZoWU",
    "Fitpack V2":                                     "1xsn_rIetuy9OJrdp1x_6BgeG1zw4aBN4",
    "Cascade Mug Alternative":                        "15aBMA9StZD3OVsion6SylNR4h753XGFJ",
    "Cork Notebook":                                  "12zRZQVo3L82Tm9tVFm1fzahC5G5T5VNm",
}

# (Sr No, Product name, Brand, Style(Gender), Description)
ROWS = [
 (1,"ET-TU Metro Drifit polo - Black","ET-TU","","Composition 90% Polyester 10% Spandex. Fit: Regular. Weight: 160 gsm. Set in sleeve. Flat knit rib collar. Self collar neck tape. 2 button matching body colour placket. Reflective stripe sleeve hem and below collar at back. Twin double needle top stitch at bottom hem and sleeve hem. Stay stylish and safe with our classic short sleeve polo featuring reflective tape on the sleeve and back neck. Enjoy comfort, freedom of movement, and a sleek profile with a two-button placket and side vents. Perfect for daily workouts, golf, cricket, and athleisure."),
 (2,"ET-TU Galactic Drifit polo - Grey","ET-TU","","Galactic Polo – Engineered for performance, this stretchable, breathable microfiber polo offers compression fit for ultimate comfort and flexibility. Perfect for active wear with a sleek, modern design. Set in sleeve. 3 button placket. Self fabric single part collar. Twin needle top stitch at sleeve hem and bottom hem. Product features: Stretch. Breathable. Compression. Micro fiber. Skin friendly. Composition 100% Polyester. Fit: Regular. Sizes: S - 4XL"),
 (3,"ET-TU Recycled Numa Hoodie - Black","ET-TU","","Stay warm and eco-friendly with the Recycled Numa Hoodie. Made from sustainable materials, this hoodie offers a soft, comfortable fit with a modern design. Perfect for layering or casual wear, it combines style and environmental responsibility. Raglan sleeve with contrast piping. Double layered hood in self-fabric. 1x1 striped rib at sleeve and bottom hem. Kangaroo pockets with twin double needle top stitch. Flat body colour drawstring. Stay-warm. Stretchable. Sustainable. 60% R. cotton, 36% R. polyester, 4% Spandex"),
 (4,"ET-TU Recycled Full zip classic hoodie - Black","ET-TU","","Stay cozy and eco-conscious with the Recycled Hoodie, made from sustainable materials without compromising on comfort. Featuring a soft, relaxed fit and a stylish design, it's perfect for everyday wear while supporting a greener planet. Set-in sleeve. Single layered hood in self fabric. Kangaroo pockets. YKK zip at center front in matching body color. Flat drawstring in matching body color. 2x2 rib with spandex at sleeve and bottom hem with twin double needle top stitch. 58% Recycled Cotton, 38% Recycled Polyester, 4% Spandex"),
 (5,"ET-TU Full Zip Swag Jacket - Black","ET-TU","","Durable 92% Polyester, 8% Spandex for long-lasting wear. Features a reverse-coil zipper for a sleek finish. Long sleeves for added warmth and coverage. Features front zippered pockets. Its breathable fabric ensures all-day wearability, while the sleek design and tailored fit offer a sophisticated look for any occasion. Perfect for casual outings or a polished weekend style."),
 (6,"ET-TU Vector Vest","ET-TU","","The Vector vest blends style and function with a sleek, modern design. Perfect for layering, it offers freedom of movement while providing warmth and a bold, sporty look. Ideal for workouts or casual outings, it's a versatile addition to any wardrobe. Cadet-collar in self-fabric, YKK zip at centre front and 3 pockets in body colour. Panelled jacket. Wide self fabric piping at armhole. Twin double needle top stitch at bottom hem. Moisture wicking, 4 way stretch, breathable, anti static"),
 (7,"ET-TU Summer Tech Polo Women's","ET-TU","Women's","100% Polyester. Enhance your active wardrobe with our timeless Summer Tech Polo. Featuring a three-button placket and rib collar detail, it offers breathability for sports, gym, yoga, and outdoor adventures like golf, running, cycling, and travel. Set in sleeve. Flat knit rib on collar and sleeve hem. Self collar neck tape. 2 buttons in matching body colour. Twin double needle top stitch at bottom hem. UV protection. Breathable. Anti odor. Anti static"),
 (8,"travelXOXO ladies Neoprene tote bag","travelXOXO","","Made from 600D TPU coated rPET and neoprene using recycled materials. Spacious open cavity fits towels and large beach essentials. Interior water-resistant zippered pocket for organized storage. Versatile carry options with padded grab handles and fixed shoulder straps"),
 (9,"travelXOXO Foldable Car Trunk Organiser","travelXOXO","","Spacious trunk organizer with multiple compartments for efficient storage and organization. Reinforced construction with sturdy base panels ensures enhanced durability and shape retention. Features adjustable dividers to customize storage space according to your needs. Non-slip base and adjustable securing straps keep the organizer firmly in place during travel. Multiple mesh and covered side pockets provide easy access to smaller essentials. Foldable design allows compact storage when not in use and easy portability. Dimensions: 25D x 41W x 55H cm"),
 (10,"travelXOXO Cabin Luggage Harness & Backpack","travelXOXO","","Crafted from high-quality recycled nylon for enhanced durability and sustainability. Functions as both a cabin luggage harness and a convertible backpack for versatile travel. Securely attaches to compatible cabin suitcases using adjustable fastening straps. Hidden, adjustable shoulder straps allow quick conversion into a comfortable backpack. Features multiple compartments for organized storage and easy access to travel essentials. Two spacious zippered pockets accommodate laptops up to 16 inches, documents, magazines, or other daily essentials. Dimensions: 39 x 31 x 9 cm"),
 (11,"travelXOXO Expedia Sling","travelXOXO","","Contemporary sling bag with a compact design and spacious interior for everyday essentials. Flap and zipper closure provide added security for your belongings. Back slip pocket offers quick and easy access to frequently used items. Adjustable shoulder strap ensures a comfortable, customized fit. Water-resistant PU-coated premium polyester construction for enhanced durability. Soft, lightweight design makes it ideal for casual outings, travel, and daily use. Dimensions: 23 cm (L) x 15 cm (H) x 6.5 cm (W)"),
 (12,"travelXOXO Bottle Carrier Bag","travelXOXO","","Crafted from recycled PU with a PEVA-insulated lining for durability and temperature retention. Thermally insulated main compartment helps keep bottles cool for longer. Designed to fit bottles up to 60 oz securely. Sturdy black rope closure keeps the bottle firmly in place. Zippered front pocket provides convenient storage for small essentials such as keys, cards, or cash. Adjustable webbing shoulder strap offers comfortable, hands-free carrying. Lightweight and compact design is ideal for commuting, travel, hiking, and outdoor activities."),
 (13,"travelXOXO Saba Sling","travelXOXO","","Durable hard cotton canvas exterior offers a rugged look and long-lasting performance. Nylon interior lining provides added durability and protects stored belongings. Spacious main compartment accommodates daily essentials with ease. Includes a detachable inner pouch for convenient organization of smaller items. Premium YKK metal zipper ensures smooth operation and reliable closure. Technical nylon webbing handles provide a comfortable and secure grip. Reinforced construction enhances strength for everyday use. Designed for work, travel, shopping, and daily commuting."),
 (14,"travelXOXO Sports Sling","travelXOXO","","Crafted from durable 230D twill polyester with a 240D polyester lining for long-lasting performance. Spacious double-zippered main compartment provides secure storage for daily essentials. Front zippered pocket offers quick access to frequently used items. Front slip pocket adds convenient storage for small accessories. Back zippered pocket features an integrated elastic cup holder for added functionality. Interior slip pocket helps keep valuables and essentials organized. Adjustable padded shoulder sling ensures comfortable carrying throughout the day."),
 (15,"travelXOXO Basecamp Duffle Bag 32 Ltr","travelXOXO","","Inspired by the iconic Base Camp Duffel, designed as a versatile and durable travel companion. 32-litre capacity makes it suitable for day trips, overnight stays and short getaways. Made from reverse material, using 300D recycled polyester tarpaulin with a TPU coating for durability. Water-repellent construction helps protect belongings from light moisture and changing weather conditions. Includes a dedicated water bottle pocket for convenient access while travelling. Dedicated laptop sleeve accommodates laptops up to 16.5 inches. Lightweight design weighs approximately 910 g."),
 (16,"Transit backpack","travelXOXO","","Comes with 2 padded laptop pockets for secure storage. Includes 7 open pockets for storage and card organization. Features a dedicated 15 inch laptop compartment. Extra shoulder pads enhance carrying comfort. Adjustable shoulder straps offer a personalized fit. Dimensions: 18.5H x 12.5W x 8.5D cm"),
 (17,"Fitpack V2","travelXOXO","","Crafted from premium 1680D Cordura ballistic nylon for exceptional durability and abrasion resistance. High-quality YKK zippers and Duraflex hardware ensure reliable, long-lasting performance. Antimicrobial interior lining helps reduce bacterial growth and control odors. Spacious front-loading main compartment provides easy access and efficient organization. Dedicated ventilated shoe compartment. Suspended, padded laptop compartment with soft lining securely fits laptops up to 16 inches. Quick-access top pocket keeps frequently used essentials to hand."),
 (18,"Limited Edition Backpack","travelXOXO","","Crafted from premium 1680D Cordura ballistic nylon for exceptional durability and abrasion resistance. High-quality YKK zippers and Duraflex hardware ensure reliable, long-lasting performance. Antimicrobial interior lining helps reduce bacterial growth and control odors. Spacious front-loading main compartment provides easy access and efficient organization. Dedicated ventilated shoe compartment. Suspended, padded laptop compartment with soft lining securely fits laptops up to 16 inches. Quick-access top pocket keeps frequently used essentials to hand."),
 (19,"Himalayan Tumbler Alternative","HydroMonk","","304 stainless steel. After filling with a cold beverage, the tumbler keeps it cold. Premium quality stainless steel keeps drinks contained and prevents heat or cold from escaping. Double-wall vacuum insulation protects your hot or cold beverage. Dimensions: 470 x 470 x 200 mm"),
 (20,"Cascade Mug Alternative","HydroMonk","","Made from 90% recycled 18/8 stainless steel, BPA-free. Double-wall vacuum insulation with powder coat finish. Includes reusable straw and comfort-grip handle. Car cup holder compatible (base diameter 3.1 inches). Dishwasher safe for easy cleaning"),
 (21,"OMG Twill Cap","OMG","","The 6 panel cap comes with neat stitching, high quality cotton fabric and an adjustable strapback. Our popular structured 100% cotton twill cap. This value-priced style has a high profile and plenty of colours to uniform the team. Available in a variety of colours. An ideal promotional gift for any outdoor event, with branding options available. Closure: hook and loop."),
 (22,"Cork Notebook","SOIL","","Premium eco-friendly notebook with a natural cork cover for a unique and sustainable finish. Durable hard cover protects pages while offering a stylish, minimalist look. Smooth, high-quality paper provides an excellent writing experience with minimal ink bleed-through. Elastic closure keeps the notebook securely closed and pages protected. Built-in ribbon bookmark allows quick and convenient access to important notes. Integrated pen loop keeps your writing instrument within easy reach."),
]

# Kept byte-for-byte in step with classify_() in apps-script-feed/Code.gs. If
# you change a rule there, change it here too or the bundled snapshot and the
# live feed will group the same product under two different categories.
NEUTRALIZE = [
    r"bottle (pocket|pockets|holder|holders|sleeve|compartment|cage|opener)",
    r"(screw|flip|flip-top|flip top|leak-?proof|spill-?proof|stylish|sipper|push-?button|press|one-press|twist|sliding|as sliding) (lid|cap)",
    r"bottle cap", r"pen (loop|loops|holder|pocket|slot)",
    r"shoe (pouch|pocket|compartment|bag)",
    r"(luggage|trolley) (mount|strap|straps|sleeve|pass-?through|pass|tag|handle)",
    r"bottle green", r"water bottle pocket",
    # An elastic cup holder is a pocket; a cabin luggage harness worn as a
    # backpack is a backpack. Each otherwise trips a Drinkware or Trolley
    # rule on a word in the description. "bottle carrier" is deliberately NOT
    # here — it is handled by an ordered rule, and neutralising it would
    # erase the phrase that rule matches on.
    r"cup ?holders?", r"cabin luggage", r"luggage harness",
]
RULES = [
    (r"gift box", "Gift Box", "Gift Box"),
    (r"lunch ?box", "Utilities", "Accessories"),
    # Before the bottle rule: a carrier is the bag, not what goes in it.
    (r"carrier bag|bottle carrier", "Travel", "Travel accessories"),
    (r"\bbottle|\bflask|\bsipper|sports bottle|\bthermos\b|insulated (bottle|flask)", "Drinkware", "Bottles"),
    (r"\bcap\b|\bcaps\b|beanie|bucket hat|\bvisor\b", "Apparel", "Headwear"),
    (r"hoodie|sweat ?shirt|half-?zip|quarter-?zip|hooded", "Apparel", "Hoodies"),
    (r"\bvest\b|\bjacket|\bpuffer|\bfleece|\bbomber|track top|track jacket|track suit|tracksuit|windcheater|\bgilet", "Apparel", "Jackets"),
    (r"\bpolo|t-?shirt|\bt shirt|\btee\b|round neck|round-neck|crew neck|henley", "Apparel", "T-Shirts"),
    (r"formal shirt|dress shirt|\bshirt", "Apparel", "Shirts"),
    (r"\bshoes\b|sneaker|running shoes|sports shoes|footwear", "Apparel", "Footwear"),
    (r"sound ?bar|\bspeaker|earbud|ear ?phone|head ?phone|neckband|smart ?watch|\bear ?buds?\b", "Tech", "Audio & Wearables"),
    (r"power ?bank|wireless charg|charging (station|dock|cable)|multi-?charging|\bcharger\b|\badapter\b|charging cable", "Tech", "Power & Charging"),
    (r"air ?fryer|\bkettle\b|induction|cook ?top|\bblender|\bjuicer|\bgrinder|garment steamer|\bsteamer\b|vacuum cleaner|\bmixer|hand fan|\bmop\b", "Tech", "Appliances"),
    (r"tumbler|travel mug|coffee mug|ceramic (mug|cup)|\bmug\b|\bmugs\b|\bcup\b", "Drinkware", "Mugs & tumblers"),
    (r"trolley|suit ?case|luggage|\bcabin\b|polycarbonate|polypropylene|hard ?top|hard-?shell|hard-?sided|travel gear|spinner wheel|telescopic", "Travel", "Trolley bags"),
    (r"laptop backpack|\bbackpack\b|back pack|rucksack|daypack|\bfitpack\b", "Travel", "Backpack"),
    (r"\bduffle|\bduffel|weekender|gym bag", "Travel", "Duffle bag"),
    (r"\btote\b|\bjute\b|cotton tote|shopper|shopping bag", "Travel", "Tote bags"),
    (r"laptop sleeve|laptop bag|\bmessenger|\bsling|crossbody|work folio|\bfolio\b|file case|briefcase", "Travel", "Laptop handbag"),
    (r"passport|dopp kit|toiletry|toiletary|neck pillow|travel set|lunch bag|packing|organiser|organizer|carrier bag|cooler", "Travel", "Travel accessories"),
    (r"\bcoaster", "Utilities", "Coasters"),
    (r"twist-mechanism pen|ball ?point|roller ?ball|stylus pen|\bpen\b(?! ?(loop|holder|stand|pocket|slot))|\bpens\b", "Utilities", "Pens"),
    (r"note ?book|\bdiary\b|journal|notepad|memo ?pad|organizer diary", "Utilities", "Notebook"),
    (r"wallet|key ?chain|card holder|\bpouch|organiz|\bstand\b|desk|tech organizer", "Utilities", "Accessories"),
]


def scrub(s):
    t = s.lower()
    for n in NEUTRALIZE:
        t = re.sub(n, " ", t)
    return t


def classify(name, brand, desc):
    """The NAME decides; the description is only consulted as a fallback.

    Descriptions list what a product holds, and that is not what it is. See
    the matching comment in apps-script-feed/Code.gs.
    """
    if "gift box" in name.lower():
        return "Gift Box", "Gift Box"
    by_name = scrub(f"{name} {brand}")
    for pat, cat, sub in RULES:
        if re.search(pat, by_name):
            return cat, sub
    by_all = scrub(f"{name} {brand} {desc}")
    for pat, cat, sub in RULES:
        if re.search(pat, by_all):
            return cat, sub
    return "Utilities", "Accessories"


def main():
    products = []
    for sr, name, brand, gender, desc in ROWS:
        cat, sub = classify(name, brand, desc)
        fid = IMG.get(name, "")
        products.append({
            "sku": f"WF{sr:04d}",
            "name": name,
            "category": cat,
            "subcategory": sub,
            "brand": brand,
            "description": desc,
            "gender": gender,
            "colors": [],
            "lead_time": "35 Business Days",
            # No prices anywhere. See apps-script-feed/Code.gs.
            "moq": 0, "gst_rate": 0, "tiers": [], "base_price": 0,
            "sizes": ["OS"], "has_sizes": False,
            "image": f"https://drive.google.com/thumbnail?id={fid}&sz=w1000" if fid else "",
            "image_source": "drive-match" if fid else "none",
            "active": True, "related": [], "event_tags": [],
            "top_selling": False,
            "sustainable": bool(re.search(r"sustainab|recycled|eco-?friendly|rpet", desc, re.I)),
            "parent_sku": "",
        })

    out = {
        "generated_at": "2026-09-25T00:00:00.000Z",
        "brand": "Wells Fargo",
        "pricing": "hidden",
        "source_sheet": SHEET,
        "categories": [c for c in ["Apparel", "Drinkware", "Travel", "Tech", "Utilities", "Gift Box"]
                       if any(p["category"] == c for p in products)],
        "products": products,
        "event_kits": [],
    }
    path = os.path.join(os.path.dirname(__file__), "..", "assets", "products.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)

    withimg = sum(1 for p in products if p["image"])
    print(f"wrote {len(products)} products, {withimg} with a photo, "
          f"{len(products) - withimg} awaiting one")
    for c in out["categories"]:
        print(f"  {c}: {sum(1 for p in products if p['category'] == c)}")


if __name__ == "__main__":
    main()
