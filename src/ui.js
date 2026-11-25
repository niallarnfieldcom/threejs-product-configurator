// Panel wiring: swatch grids, environment + camera segments, share URL, screenshot.

import QRCode from 'qrcode';
import {
  productConfigSlots,
  readConfiguration,
  serializeConfiguration,
} from './config-state.js';

// Colour-only finishes paint as a flat colour; textured sets show their thumbnail.
function paintSwatch(el, sw) {
  const flat = sw?.pbr?.color && !sw.pbr.maps;
  el.style.backgroundImage = sw && !flat ? `url(${sw.thumb})` : "none";
  el.style.backgroundColor = flat ? sw.pbr.color : "";
}

export function initUI({ swatches, state, callbacks, features = [], product = null }) {
  // panel tabs
  document.querySelectorAll("#tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".pane").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab)?.classList.add("active");
    });
  });

  // Rendering-engine feature toggles
  const featGrid = document.getElementById("feature-grid");
  for (const f of features) {
    const el = document.createElement("div");
    el.className = "feat" + (f.on ? " on" : "");
    el.innerHTML = `<span class="dot"></span>${f.label}`;
    el.addEventListener("click", () => {
      f.on = !f.on;
      el.classList.toggle("on", f.on);
      callbacks.onFeature(f.key, f.on);
    });
    featGrid.appendChild(el);
  }
  const grid = document.getElementById("swatch-grid");
  const toast = document.getElementById("toast");
  let toastTimer = null;

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  // ---- slot tabs + swatch grid ----
  // Group swatches into labelled sections (Fabrics / Laminates / Saved) so a large
  // material library stays navigable. Category comes off the swatch (mapped from the
  // PBR material); presets have none → "saved".
  const GROUPS = [
    ["upholstery", "Fabrics"],
    ["laminate", "Laminates"],
    ["saved", "Saved"],
  ];
  const groupOf = (sw) => sw.category || (sw.custom ? "saved" : "upholstery");

  // Slot tabs are built per-product from its swatchable slots (in canonical a/b/c/d
  // order) so they track whatever product is loaded — not a hardcoded A/B.
  const slots = productConfigSlots(product);
  if (!slots.includes(state.activeSlot)) state.activeSlot = slots[0] || "";
  const slotTabsEl = document.getElementById("slot-tabs");
  if (slotTabsEl) {
    slotTabsEl.innerHTML = slots.map((s) => `
      <button type="button" class="slot-tab${s === state.activeSlot ? " active" : ""}" id="tab-${s}" data-slot="${s}" aria-pressed="${s === state.activeSlot}">
        <div class="chip" id="chip-${s}"></div>
        <div class="meta"><b>SLOT ${s.toUpperCase()}</b><span id="name-${s}">—</span></div>
      </button>`).join("");
  }

  function renderGrid() {
    if (!slots.length) { grid.innerHTML = ""; return; } // fixed-finish-only product
    grid.innerHTML = "";
    const buckets = new Map(GROUPS.map(([k]) => [k, []]));
    for (const sw of swatches) {
      const g = groupOf(sw);
      (buckets.get(g) || buckets.get("upholstery")).push(sw);
    }
    // Show only the active slot's material type: a fabric slot shows Fabrics, a
    // laminate slot shows Laminates (Saved always shown). Unknown → show all.
    const finish = product?.slotFinish?.[state.activeSlot];
    const wantCat = finish === "laminate" ? "laminate" : finish === "fabric" ? "upholstery" : null;
    for (const [key, label] of GROUPS) {
      if (wantCat && key !== "saved" && key !== wantCat) continue;
      const items = buckets.get(key);
      if (!items || !items.length) continue;
      const head = document.createElement("div");
      head.className = "sw-head";
      head.textContent = `${label} · ${items.length}`;
      grid.appendChild(head);
      const row = document.createElement("div");
      row.className = "sw-row";
      for (const sw of items) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "swatch";
        el.setAttribute("aria-label", sw.name);
        el.setAttribute("aria-pressed", String(state[state.activeSlot] === sw.id));
        paintSwatch(el, sw);
        if (state[state.activeSlot] === sw.id) el.classList.add("selected");
        const tip = document.createElement("span");
        tip.className = "tip";
        tip.textContent = sw.name;
        el.appendChild(tip);
        el.addEventListener("click", () => {
          state[state.activeSlot] = sw.id;
          callbacks.onFabric(state.activeSlot, sw);
          syncSlotTabs();
          renderGrid();
        });
        if (sw.custom) el.style.outline = "1px dashed var(--accent)";
        row.appendChild(el);
      }
      grid.appendChild(row);
    }
  }

  function syncSlotTabs() {
    for (const slot of slots) {
      const sw = swatches.find((s) => s.id === state[slot]);
      const chip = document.getElementById(`chip-${slot}`);
      const name = document.getElementById(`name-${slot}`);
      const tab = document.getElementById(`tab-${slot}`);
      if (chip) paintSwatch(chip, sw);
      if (name) name.textContent = sw ? sw.name : "—";
      if (tab) {
        const active = state.activeSlot === slot;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-pressed", String(active));
      }
    }
  }

  for (const slot of slots) {
    document.getElementById(`tab-${slot}`)?.addEventListener("click", () => {
      state.activeSlot = slot;
      syncSlotTabs();
      renderGrid();
    });
  }

  // ---- segmented controls ----
  function wireSeg(id, attr, onPick) {
    const seg = document.getElementById(id);
    if (!seg) return; // segment may have been removed from the panel
    seg.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        seg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        onPick(btn.dataset[attr]);
      });
    });
  }
  wireSeg("env-seg", "env", (env) => {
    state.env = env;
    callbacks.onEnv(env);
  });
  wireSeg("cam-seg", "cam", (cam) => {
    state.cam = cam;
    callbacks.onCamera(cam);
  });

  function setSegActive(id, attr, value) {
    document.querySelectorAll(`#${id} button`).forEach((b) =>
      b.classList.toggle("active", b.dataset[attr] === value)
    );
  }

  // ---- share + screenshot ----
  document.getElementById("btn-share").addEventListener("click", () => {
    showShareDialog(state, showToast, product);
  });
  document.getElementById("btn-screenshot")?.addEventListener("click", () => callbacks.onScreenshot?.());

  // initial paint
  syncSlotTabs();
  renderGrid();
  setSegActive("env-seg", "env", state.env);
  setSegActive("cam-seg", "cam", state.cam);

  // ---- Get a quote (client / liquid-glass surface) ----
  document.getElementById("btn-quote")?.addEventListener("click", () => callbacks.onQuote?.());

  return { showToast, refreshGrid: renderGrid, syncSlots: syncSlotTabs };
}

export function readStateFromURL(swatches, defaults, product = null) {
  return readConfiguration(location.search, { product, swatches, defaults });
}

// ---- Phone QR / share dialog helpers ----------------------------------------

function shareParams(state, product) {
  const params = serializeConfiguration(state, product);
  const productId = new URLSearchParams(location.search).get("product"); // carry the active product
  if (productId) params.set("product", productId);
  return params.toString();
}

function buildShareURL(state, product) {
  const url = new URL(location.href);
  url.search = shareParams(state, product);
  return url;
}

async function discoverLANIP() {
  // More reliable WebRTC discovery using a public STUN server
  return new Promise((resolve) => {
    let done = false;
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pc.createDataChannel("");
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
    pc.onicecandidate = (ev) => {
      if (done) return;
      const cand = ev.candidate?.candidate || "";
      const m = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(cand);
      if (m) {
        const ip = m[1];
        // only accept a private LAN address — a public IP won't be reachable from the phone
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) {
          done = true;
          pc.close();
          resolve(ip);
        }
      }
    };
    setTimeout(() => {
      if (!done) {
        pc.close();
        resolve(null);
      }
    }, 1800);
  });
}

function buildPhoneURL(host, port, state, product) {
  const search = shareParams(state, product); // includes product + every configurable slot
  const cleanHost = host.includes(":") ? `[${host}]` : host; // ipv6 safety
  return `http://${cleanHost}:${port}/?${search}`;
}

export function showShareDialog(state, showToast, product) {
  const originalURL = buildShareURL(state, product);
  const loadedHost = location.hostname;
  const loadedPort = location.port || "5174";
  const isLocalLoad = loadedHost === "localhost" || loadedHost === "127.0.0.1" || loadedHost === "[::1]";

  // Addresses injected by the Vite plugin (the exact non-internal IPv4s the dev server is listening on).
  // This is the most reliable source — the same ones Vite prints as "Network:".
  const viteNetworkIPs = (typeof __VITE_NETWORK_IPS__ !== "undefined" && Array.isArray(__VITE_NETWORK_IPS__))
    ? __VITE_NETWORK_IPS__
    : [];

  // remove any previous instance
  document.getElementById("qr-modal")?.remove();

  // inject styles once
  const styleId = "qr-modal-styles";
  if (!document.getElementById(styleId)) {
    const s = document.createElement("style");
    s.id = styleId;
    s.textContent = `
      #qr-modal { position:fixed; inset:0; z-index:100; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,0.68); backdrop-filter:blur(8px); }
      #qr-modal .card { width:min(92vw, 380px); background:var(--panel); border:1px solid var(--panel-border);
        border-radius:18px; overflow:hidden; box-shadow:0 24px 70px rgba(0,0,0,0.55); }
      #qr-modal .head { padding:16px 18px 12px; border-bottom:1px solid var(--panel-border);
        display:flex; align-items:center; justify-content:space-between; gap:12px; }
      #qr-modal .head h3 { font-size:15px; font-weight:600; letter-spacing:.01em; }
      #qr-modal .head .close { min-width:44px; min-height:44px; background:none; border:0; color:var(--ink-dim); font-size:22px; line-height:1;
        cursor:pointer; padding:0 4px; opacity:.8; }
      #qr-modal .body { padding:18px 18px 16px; display:flex; flex-direction:column; align-items:center; gap:10px; }
      #qr-modal .warning { font-size:11px; color:#ffcc66; background:rgba(255,180,0,0.1); border:1px solid rgba(255,180,0,0.3);
        padding:8px 10px; border-radius:8px; text-align:center; width:100%; }
      #qr-modal canvas { border-radius:10px; background:#fff; padding:11px; box-shadow:0 6px 18px rgba(0,0,0,0.3); }
      #qr-modal .url { font:10.5px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--ink-dim);
        word-break:break-all; max-width:100%; background:rgba(255,255,255,0.035); padding:8px 10px; border-radius:8px;
        border:1px solid var(--panel-border); cursor:pointer; user-select:all; }
      #qr-modal .hint { font-size:10.5px; color:var(--ink-dim); text-align:center; line-height:1.35; max-width:300px; opacity:.9; }
      #qr-modal .lan { font-size:10.5px; color:var(--accent); min-height:16px; text-align:center; }
      #qr-modal .host-editor { display:flex; gap:6px; width:100%; align-items:center; }
      #qr-modal .host-editor input { font:12px ui-monospace, monospace; padding:7px 9px; border-radius:8px; border:1px solid var(--panel-border);
        background:rgba(255,255,255,0.04); color:var(--ink); }
      #qr-modal .host-editor input.host { flex:1; min-width:0; }
      #qr-modal .host-editor input.port { width:68px; text-align:center; }
      #qr-modal .host-editor button { min-height:44px; padding:7px 12px; font-size:12px; font-weight:600; border-radius:8px; border:1px solid var(--panel-border);
        background:rgba(255,255,255,0.07); color:var(--ink); cursor:pointer; white-space:nowrap; }
      #qr-modal .actions { display:flex; gap:8px; width:100%; padding:4px 2px 2px; margin-top:4px; }
      #qr-modal .actions button { flex:1; min-height:44px; font:inherit; font-size:12.5px; font-weight:600; padding:10px 0; border-radius:10px;
        border:1px solid var(--panel-border); background:rgba(255,255,255,0.07); color:var(--ink); cursor:pointer; transition:background .15s; }
      #qr-modal .actions button:hover { background:rgba(255,255,255,0.12); }
      #qr-modal .actions button.primary { background:var(--accent); border-color:var(--accent); color:#181613; }
      #qr-modal .actions button.primary:hover { background:#d8b97c; }
      #qr-modal .qr-placeholder { width:272px; height:272px; border:2px dashed var(--panel-border); border-radius:10px;
        display:flex; align-items:center; justify-content:center; font-size:12px; color:var(--ink-dim); text-align:center; padding:12px; }
    `;
    document.head.appendChild(s);
  }

  const modal = document.createElement("div");
  modal.id = "qr-modal";
  modal.innerHTML = `
    <div class="card">
      <div class="head">
        <h3>📱 Test on your phone</h3>
        <button class="close" aria-label="Close">×</button>
      </div>
      <div class="body">
        <div id="qr-warning" class="warning" style="display:none">
          You loaded the page on <b>localhost</b>. The fields below are set to your network address (from Vite). The QR will use the network IP so your phone can reach it.
        </div>

        <div class="host-editor">
          <input id="qr-host" class="host" placeholder="192.168.1.20" spellcheck="false">
          <input id="qr-port" class="port" type="text" value="${loadedPort}">
          <button id="qr-update">Update QR</button>
        </div>

        <div id="qr-lan" class="lan"></div>

        <div id="qr-box"></div>

        <div class="url" id="qr-url" title="Click to copy" style="display:none"></div>

        <div class="hint">
          Phone must be on the <b>same Wi-Fi</b> as this computer. The address in the QR above is what your phone will open.
        </div>

        <div class="actions">
          <button id="qr-copy">Copy link</button>
          <button id="qr-done" class="primary">Done</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector(".close").onclick = close;
  modal.querySelector("#qr-done").onclick = close;
  modal.onclick = (e) => { if (e.target.id === "qr-modal") close(); };

  const box = modal.querySelector("#qr-box");
  const urlEl = modal.querySelector("#qr-url");
  const lanEl = modal.querySelector("#qr-lan");
  const warningEl = modal.querySelector("#qr-warning");
  const hostInput = modal.querySelector("#qr-host");
  const portInput = modal.querySelector("#qr-port");
  const updateBtn = modal.querySelector("#qr-update");

  let target = "";

  async function renderQR(targetUrl) {
    box.innerHTML = "";
    const c = document.createElement("canvas");
    box.appendChild(c);
    try {
      await QRCode.toCanvas(c, targetUrl, {
        width: 272, margin: 1,
        color: { dark: "#0f0f0f", light: "#ffffff" },
      });
      urlEl.style.display = "";
      urlEl.textContent = targetUrl;
    } catch (err) {
      box.textContent = "Could not generate QR";
      console.error(err);
    }
  }

  async function usePhoneURL(url) {
    target = url;
    await renderQR(url);
  }

  function getCurrentPhoneURL() {
    let host = hostInput.value.trim() || loadedHost;
    const port = portInput.value.trim() || loadedPort;

    // Last-resort safety: never return a localhost URL for the QR if the plugin knows better addresses
    if (host.match(/^(localhost|127\.0\.0\.1|\[::1])$/) && viteNetworkIPs.length > 0) {
      host = viteNetworkIPs[0];
      hostInput.value = host; // reflect it in the UI
    }

    return buildPhoneURL(host, port, state, product);
  }

  function updateQRFromEditor() {
    const host = hostInput.value.trim();
    const url = getCurrentPhoneURL();

    // Never let a localhost host win if we have a better one available
    if (host.match(/^(localhost|127\.0\.0\.1|\[::1\])$/) && viteNetworkIPs.length > 0) {
      hostInput.value = viteNetworkIPs[0];
    }

    if (hostInput.value.trim() && !hostInput.value.trim().match(/^(localhost|127\.0\.0\.1|\[::1\])$/)) {
      usePhoneURL(url).catch(() => {});
    } else {
      box.innerHTML = `<div class="qr-placeholder">Paste the <b>Network</b> IP from the terminal<br>then click Update QR</div>`;
      urlEl.style.display = "none";
      urlEl.textContent = "";
    }
  }

  // Wire the update button + live-ish updates
  updateBtn.onclick = updateQRFromEditor;
  hostInput.addEventListener("keydown", (e) => { if (e.key === "Enter") updateQRFromEditor(); });
  portInput.addEventListener("keydown", (e) => { if (e.key === "Enter") updateQRFromEditor(); });
  // Auto-update a short moment after typing (debounce feel)
  let typingTimer;
  const scheduleUpdate = () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (hostInput.value.trim()) updateQRFromEditor();
    }, 450);
  };
  hostInput.addEventListener("input", scheduleUpdate);
  portInput.addEventListener("input", scheduleUpdate);

  // Initial state — strongly prefer server-injected addresses or a non-local load
  // This is the key part that prevents localhost QRs
  let bestInitialHost = viteNetworkIPs[0] || (isLocalLoad ? "" : loadedHost);

  if (isLocalLoad) {
    warningEl.style.display = "block";
  }

  // If we are on localhost but the plugin gave us real network IPs, force the first good one
  if (isLocalLoad && viteNetworkIPs.length > 0) {
    bestInitialHost = viteNetworkIPs[0];
  }

  if (bestInitialHost && !bestInitialHost.match(/^(localhost|127\.0\.0\.1|\[::1\])$/)) {
    hostInput.value = bestInitialHost;
    const initialURL = buildPhoneURL(bestInitialHost, portInput.value.trim() || loadedPort, state, product);
    usePhoneURL(initialURL).catch(() => {});
    lanEl.textContent = `QR target: ${bestInitialHost}`;
  } else {
    // No good host known yet (rare) — force manual entry
    box.innerHTML = `<div class="qr-placeholder">Paste the <b>Network</b> address from your terminal<br>(the 192.168... line) then click Update QR</div>`;
    urlEl.style.display = "none";
  }

  // Show what Vite / the plugin knows
  if (viteNetworkIPs.length > 0) {
    lanEl.innerHTML = (lanEl.innerHTML || "") + ` &nbsp; Vite: ${viteNetworkIPs.join(", ")}`;
  }

  // copy
  const doCopy = async () => {
    const toCopy = target || getCurrentPhoneURL();
    try {
      await navigator.clipboard.writeText(toCopy);
      showToast?.("Link copied to clipboard");
    } catch {
      window.prompt("Copy this URL for your phone:", toCopy);
    }
  };
  modal.querySelector("#qr-copy").onclick = doCopy;
  urlEl.onclick = doCopy;

  // ---- Prefer a public tunnel link so the QR works on ANY network -----------
  // Source order: public/share-url.txt (written when a tunnel is running) →
  // the current origin if the app itself is already loaded on a public host.
  let tunnelApplied = false;
  (async () => {
    let base = null;
    try {
      const txt = (await fetch("/share-url.txt", { cache: "no-store" }).then((r) => (r.ok ? r.text() : ""))).trim();
      if (/^https?:\/\//.test(txt)) base = txt.replace(/\/+$/, "");
    } catch {}
    if (!base && !isLocalLoad && location.protocol === "https:") base = location.origin.replace(/\/+$/, "");
    if (!base) return; // no tunnel configured — keep the LAN flow
    tunnelApplied = true;
    const url = `${base}/?${shareParams(state, product)}`;
    const editor = modal.querySelector(".host-editor"); if (editor) editor.style.display = "none";
    warningEl.style.display = "none";
    const hint = modal.querySelector(".hint"); if (hint) hint.innerHTML = "🌐 Public link — works on any network (mobile data or Wi-Fi).";
    lanEl.innerHTML = `Public link active`;
    await usePhoneURL(url);
  })().catch(() => {});

  // WebRTC discovery as fallback / extra option (runs in parallel)
  discoverLANIP().then((ip) => {
    if (tunnelApplied || !ip) return;

    const current = hostInput.value.trim();
    const currentLooksLocal = !current || current.match(/^(localhost|127\.0\.0\.1|\[::1\])$/);

    if (currentLooksLocal) {
      // Force a good address into the QR so the user doesn't get a broken localhost QR
      hostInput.value = ip;
      const goodURL = buildPhoneURL(ip, portInput.value.trim() || loadedPort, state, product);
      usePhoneURL(goodURL).catch(() => {});
      lanEl.innerHTML = `Auto-detected network IP: <b>${ip}</b>`;
    } else if (ip !== current) {
      lanEl.innerHTML = (lanEl.innerHTML || "") + ` • also seen ${ip}`;
    }
  });
}
