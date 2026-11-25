export const CONFIG_SLOTS = Object.freeze(["a", "b", "c", "d"]);
export const CONFIG_ENVS = Object.freeze(["studio", "hdri", "loft"]);
export const CONFIG_CAMERAS = Object.freeze(["hero", "front", "detail", "back"]);

const allowed = (value, values, fallback) => values.includes(value) ? value : fallback;

export function productConfigSlots(product) {
  const declared = Array.isArray(product?.fabricSlots) ? product.fabricSlots : [];
  const declaredSet = new Set(declared);
  return CONFIG_SLOTS.filter((slot) => declaredSet.has(slot));
}

export function createConfigurationDefaults(product, defaults = {}) {
  const slots = productConfigSlots(product);
  const state = {
    env: defaults.env ?? "studio",
    cam: defaults.cam ?? "hero",
    activeSlot: slots[0] || "",
  };

  for (const slot of slots) {
    state[slot] = defaults[slot] ?? product?.defaults?.[slot] ?? null;
  }
  return state;
}

export function readConfiguration(search, { product, swatches = [], defaults = {} } = {}) {
  const params = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(search || "");
  const validSwatches = new Set(swatches.map((swatch) => swatch.id));
  const state = createConfigurationDefaults(product, defaults);

  state.env = allowed(params.get("env"), CONFIG_ENVS, state.env);
  state.cam = allowed(params.get("cam"), CONFIG_CAMERAS, state.cam);

  for (const slot of productConfigSlots(product)) {
    const requested = params.get(slot);
    if (requested && validSwatches.has(requested)) state[slot] = requested;
  }

  const requestedActive = params.get("slot");
  if (requestedActive && productConfigSlots(product).includes(requestedActive)) {
    state.activeSlot = requestedActive;
  }
  return state;
}

export function serializeConfiguration(state, product, { includeProduct = false } = {}) {
  const params = new URLSearchParams();
  if (includeProduct && state?.product) params.set("product", state.product);
  if (state?.env) params.set("env", state.env);
  if (state?.cam) params.set("cam", state.cam);
  if (state?.activeSlot && productConfigSlots(product).includes(state.activeSlot)) {
    params.set("slot", state.activeSlot);
  }
  for (const slot of productConfigSlots(product)) {
    if (state?.[slot]) params.set(slot, state[slot]);
  }
  return params;
}

export function configurationSlots(state, product) {
  return Object.fromEntries(
    productConfigSlots(product)
      .filter((slot) => state?.[slot])
      .map((slot) => [slot, state[slot]])
  );
}

export function configurationPayload(state, product) {
  return {
    env: state?.env || null,
    cam: state?.cam || null,
    slots: configurationSlots(state, product),
  };
}
