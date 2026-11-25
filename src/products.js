// Data-driven product registry. Adding a product is config, not code: export its
// GLB to public/assets/<id>/model.glb with one named node per material slot, then
// add an entry here. `npm run validate:catalogue` checks the two agree.
//
// slots:        node names in the GLB that ARE the material system
// fabricSlots:  the subset a customer can change (a / b / c / d)
// slotFinish:   which material category each fabricSlot accepts
//               ("fabric" → upholstery materials, "laminate" → hard surfaces)
// fixed slots:  any other name gets a physically based finish inferred from the
//               name: chrome, black_metal, brushed, gloss, plastic, …
// targetHeight: real-world height in metres; the model is normalised to it
// pricing:      prices only show when `approved: true` (sample values here)
//
// The five sample products are generated from primitives by
// tools/generate-sample-products.py, so they carry no third-party assets.

const P = (id, name, category, targetHeight, slots, slotFinish, defaults, extra = {}) => ({
  id,
  name,
  category,
  model: `assets/${id}/model.glb`,
  targetHeight,
  slots,
  fabricSlots: Object.keys(slotFinish),
  slotFinish,
  defaults,
  ...extra,
});

const SAMPLE_PRICE = (price, leadTime) => ({ price, leadTime, pricing: { approved: true, sample: true } });

export const PRODUCTS = {
  lounge_chair: P(
    "lounge_chair", "Lounge Chair", "Seating", 0.84,
    ["a", "b", "black_metal"],
    { a: "fabric", b: "fabric" },
    { a: "pbr_velour", b: "c_charcoal" },
    {
      ...SAMPLE_PRICE("640", "4–6 weeks"),
      hotspots: [
        { label: "Removable seat cushion", pos: [0, 0.5, 0.05] },
        { label: "Angled back for lounging", pos: [0, 0.8, -0.3] },
        { label: "Tapered powder-coated legs", pos: [0.33, 0.12, 0.35] },
      ],
    },
  ),
  bar_stool: P(
    "bar_stool", "Bar Stool", "Seating", 0.78,
    ["a", "chrome"],
    { a: "fabric" },
    { a: "pbr_leather" },
    SAMPLE_PRICE("210", "2–3 weeks"),
  ),
  sofa: P(
    "sofa", "Two-Seat Sofa", "Seating", 0.82,
    ["a", "b", "black_metal"],
    { a: "fabric", b: "fabric" },
    { a: "c_oat", b: "c_oat" },
    SAMPLE_PRICE("1,290", "6–8 weeks"),
  ),
  sideboard: P(
    "sideboard", "Sideboard", "Storage", 0.75,
    ["a", "b", "black_metal", "chrome"],
    { a: "laminate", b: "laminate" },
    { a: "acg_wood095", b: "c_sage" },
    SAMPLE_PRICE("880", "4–6 weeks"),
  ),
  desk: P(
    "desk", "Writing Desk", "Desks", 0.75,
    ["a", "b", "black_metal", "chrome"],
    { a: "laminate", b: "laminate" },
    { a: "acg_wood094", b: "c_white_matt" },
    SAMPLE_PRICE("720", "3–5 weeks"),
  ),
};

export const DEFAULT_PRODUCT = "lounge_chair";

// The active product is URL-driven (?product=<id>) so the catalogue dropdown can
// switch products with a clean reload (full reinit of geometry / materials / PT),
// rather than hot-swapping the GLB and rebinding everything at runtime.
export function currentProductId() {
  const p = new URLSearchParams(location.search).get("product");
  return p && PRODUCTS[p] ? p : DEFAULT_PRODUCT;
}

// Catalogue list for the searchable dropdown: [{ id, name, category }] sorted by name.
export function productCatalogue() {
  return Object.values(PRODUCTS)
    .map((p) => ({ id: p.id, name: p.name, category: p.category || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
