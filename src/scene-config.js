// The scene the configurator shows, as data. Everything the UI and renderer
// need to know about the product lives here: where the model is, which mesh
// nodes are configurable, which finishes each one accepts, and the camera views.
//
// Model contract (see tools/prepare-scene.py): the GLB has one node per
// configurable slot, named after the slot id ("a", "b"). Every other node keeps
// the material it was authored with.
//
// Finishes come in two kinds:
//   { original: true }  the material exactly as authored in the model
//   { color: "#rrggbb" } the authored surface re-coloured. The authored texture
//                        is reduced to a neutral grain map, so the new colour
//                        keeps the same leather mottling or wood figure.
// Optional per-finish overrides: roughness, clearcoat, sheen.

export const SCENE = {
  id: "fern_room",
  name: "Fern Room",
  kind: "Two-chair salon station",
  model: "assets/fern_room/model.glb",
  height: 2.19, // metres; the model is normalised to this

  // Sample values. Prices only show when `approved` is true.
  pricing: { price: "4,850", leadTime: "8–10 weeks", approved: true, sample: true },

  slots: [
    {
      id: "a",
      label: "Leather",
      hint: "Chair upholstery",
      finishes: [
        { id: "oxblood", name: "Oxblood", original: true, swatch: "#6e1f24" },
        { id: "cognac", name: "Cognac", color: "#b06a35" },
        { id: "sand", name: "Sand", color: "#d9c3a3", roughness: 0.46 },
        { id: "olive", name: "Olive", color: "#6f7447" },
        { id: "ink", name: "Ink", color: "#2b3b57" },
        { id: "slate", name: "Slate", color: "#6a6e73" },
        { id: "black", name: "Black", color: "#26262a", roughness: 0.34 },
      ],
    },
    {
      id: "b",
      label: "Timber",
      hint: "Worktop, drawers and armrests",
      finishes: [
        { id: "walnut", name: "Oiled walnut", original: true, swatch: "#6b452c" },
        { id: "oak", name: "Natural oak", color: "#d8b98c", roughness: 0.42 },
        { id: "ash", name: "Pale ash", color: "#e6dccb", roughness: 0.44 },
        { id: "smoked", name: "Smoked oak", color: "#7d6b5a" },
        { id: "ebony", name: "Ebonised", color: "#34302d", roughness: 0.3 },
      ],
    },
  ],

  // Camera views in metres. The scene sits on y = 0, centred on the origin,
  // with the two chairs facing each other along z.
  views: [
    { id: "overview", label: "Overview", position: [3.5, 2.05, 4.3], target: [0, 0.98, 0] },
    { id: "chair", label: "Chair", position: [1.75, 1.2, 2.75], target: [0.0, 0.62, 1.25] },
    { id: "station", label: "Station", position: [2.0, 1.8, 1.95], target: [0, 1.02, 0] },
    { id: "side", label: "Side", position: [5.4, 1.5, 0], target: [0, 1.0, 0] },
  ],
};

export const slotIds = () => SCENE.slots.map((slot) => slot.id);
export const findSlot = (id) => SCENE.slots.find((slot) => slot.id === id) || null;
export const findFinish = (slotId, finishId) => findSlot(slotId)?.finishes.find((f) => f.id === finishId) || null;
export const findView = (id) => SCENE.views.find((view) => view.id === id) || null;

/** The default configuration: the first finish of every slot, first view. */
export function defaultState() {
  const state = { view: SCENE.views[0].id };
  for (const slot of SCENE.slots) state[slot.id] = slot.finishes[0].id;
  return state;
}

/** Read a configuration from URL search params, ignoring anything invalid. */
export function readState(search) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search || "");
  const state = defaultState();
  for (const slot of SCENE.slots) {
    const requested = params.get(slot.id);
    if (requested && findFinish(slot.id, requested)) state[slot.id] = requested;
  }
  const view = params.get("view");
  if (view && findView(view)) state.view = view;
  return state;
}

/** Serialise a configuration to URL search params (stable order). */
export function writeState(state) {
  const params = new URLSearchParams();
  for (const slot of SCENE.slots) {
    if (findFinish(slot.id, state?.[slot.id])) params.set(slot.id, state[slot.id]);
  }
  if (findView(state?.view)) params.set("view", state.view);
  return params;
}

/** A plain summary of a configuration, for analytics, quotes and embeds. */
export function describeState(state) {
  return {
    scene: SCENE.id,
    finishes: Object.fromEntries(SCENE.slots.map((slot) => [slot.id, findFinish(slot.id, state[slot.id])?.name ?? null])),
  };
}

/** Price info, or nulls when pricing has not been approved for display. */
export function priceInfo(overrides = null) {
  const pricing = { ...SCENE.pricing, ...(overrides || {}) };
  if (pricing.approved !== true) return { price: null, leadTime: null };
  return { price: pricing.price ?? null, leadTime: pricing.leadTime ?? null };
}
