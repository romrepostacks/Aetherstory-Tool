/* global Aether */
const A = Aether;

// ---------- storage: whole library as one IndexedDB record, localStorage fallback ----------
// ponytail: rewrites the whole library per save; fine for thousands of stories, split stores if it ever lags.
const DB_KEY = 'aetherstory';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_KEY, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function load() {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get('state');
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  } catch (e) {
    return JSON.parse(localStorage.getItem(DB_KEY) || 'null');
  }
}
async function save() {
  const data = JSON.parse(JSON.stringify(state));
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(data, 'state');
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  } catch (e) {
    try { localStorage.setItem(DB_KEY, JSON.stringify(data)); } catch (e2) { alert('Could not save: ' + e2.message + '\nExport your library from Settings.'); }
  }
}

// ---------- AI ----------
// Built-in model: WebLLM runs the model on this device's GPU (WebGPU). Weights download once and are cached by the browser.
const BUILTIN = 'builtin';
const WEBLLM = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';
const LIGHT_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
// Set while the built-in model loads or writes. If the browser kills the tab (out of memory) it survives the reload, so boot can explain.
const CRASH_KEY = 'aetherstory-builtin-running';
const mark = (v) => { try { v ? localStorage.setItem(CRASH_KEY, v) : localStorage.removeItem(CRASH_KEY); } catch (e) { /* private mode */ } };
let local = null; // { model, ready: Promise<engine> }
function builtinEngine(model) {
  if (local && local.model === model) return local.ready;
  if (!navigator.gpu) return Promise.reject(new Error('This browser has no WebGPU, so the built-in model cannot run here. Use Chrome/Edge on PC or Android, Safari on iOS 26+, or an API key.'));
  const prev = local;
  local = { model, ready: (async () => {
    if (prev) await (await prev.ready.catch(() => null))?.unload();
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('The browser cannot use this device\'s GPU, so the built-in model cannot run here. Add an API key in Settings instead.');
    // Many phones and older GPUs lack 16-bit shaders; the f32 build of the same model runs there.
    const id = adapter.features.has('shader-f16') ? model : model.replace('q4f16', 'q4f32');
    const { CreateMLCEngine } = await import(WEBLLM);
    // ponytail: 8k context fits a long story plus the world update; costs ~1GB extra GPU memory on the 3B model.
    return CreateMLCEngine(id, { initProgressCallback: (p) => setStatus(p.text) }, { context_window_size: 8192 });
  })() };
  local.ready.catch(() => { local = null; });
  return local.ready;
}
async function chatBuiltin(model, messages, temperature, { onToken, signal }) {
  let stop;
  mark(model);
  try {
    const engine = await builtinEngine(model);
    stop = () => engine.interruptGenerate();
    signal && signal.addEventListener('abort', stop);
    let full = '';
    for await (const c of await engine.chat.completions.create({ messages, temperature, stream: true })) {
      const t = (c.choices[0] && c.choices[0].delta.content) || '';
      if (t) { full += t; onToken && onToken(t); }
    }
    return full;
  } catch (e) {
    local = null; // a lost GPU device leaves the engine unusable; load fresh next time
    if (!/lost|memory|OOM|allocat/i.test(e.message)) throw e;
    throw new Error(builtinOutOfMemory(model));
  } finally {
    mark(null);
    signal && stop && signal.removeEventListener('abort', stop);
  }
}
// Out of GPU memory: drop to the lighter model so the next tap just works.
function builtinOutOfMemory(model) {
  if (model === LIGHT_MODEL) return 'This device ran out of memory running the built-in model. Add an API key in Settings to use a hosted model instead.';
  state.settings.model = LIGHT_MODEL; save();
  return 'This device ran out of memory for the full built-in model, so I switched to the lighter one. Tap Generate again.';
}

async function chat(messages, { onToken, signal, stream = true } = {}) {
  const s = state.settings;
  if (s.baseUrl === BUILTIN) return chatBuiltin(s.model, messages, Number(s.temperature) || 0.9, { onToken, signal });
  if (!s.baseUrl || !s.model) throw new Error('Set an AI provider and model in Settings first.');
  const headers = { 'Content-Type': 'application/json' };
  if (s.apiKey) headers.Authorization = 'Bearer ' + s.apiKey;
  const res = await fetch(s.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', headers, signal,
    body: JSON.stringify({ model: s.model, messages, temperature: Number(s.temperature) || 0.9, stream }),
  });
  if (!res.ok) throw new Error(`AI request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  if (!stream || !(res.headers.get('content-type') || '').includes('event-stream')) {
    const d = await res.json();
    const text = d.choices[0].message.content;
    if (onToken) onToken(text);
    return text;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const out = A.parseSSE(buf + dec.decode(value, { stream: true }));
    buf = out.rest;
    for (const t of out.tokens) { full += t; onToken && onToken(t); }
    if (out.done) break;
  }
  return full;
}

async function chatJson(messages) {
  return A.parseJsonLoose(await chat(messages, { stream: false }));
}

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    if (k === 'value') el.value = v;
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
const field = (label, input) => [h('label', {}, label), input];
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const charName = (id) => (state.characters.find((c) => c.id === id) || {}).name;

// ---------- app state & routing ----------
let state = A.emptyState();
const ui = { view: 'write', param: null, selected: [], premise: '', length: 'medium', pov: '', busy: false, status: '', currentId: null, abort: null };
const TABS = [['write', '✍️', 'Write'], ['stories', '📚', 'Stories'], ['characters', '🎭', 'Cast'], ['world', '🌍', 'World'], ['settings', '⚙️', 'Settings']];

function go(view, param = null) { ui.view = view; ui.param = param; render(); window.scrollTo(0, 0); }

function render() {
  document.getElementById('worldName').textContent = state.world.name;
  const nav = document.getElementById('nav');
  nav.replaceChildren(...TABS.map(([v, icon, label]) => h('button', { class: ui.view === v ? 'on' : '', onclick: () => go(v) }, h('span', {}, icon), label)));
  const view = document.getElementById('view');
  view.replaceChildren(...[VIEWS[ui.view]()].flat(Infinity).filter((n) => n && n.nodeType));
}

function setStatus(msg) { ui.status = msg; const el = document.getElementById('status'); if (el) el.textContent = msg; }

// ---------- generation ----------
async function generate(continueId) {
  if (ui.busy) return;
  const existing = continueId && state.stories.find((s) => s.id === continueId);
  const cast = ui.selected.length ? [...ui.selected] : state.characters.map((c) => c.id);
  const story = existing || { id: A.uid(), title: 'Untitled story', summary: '', characterIds: cast, pov: cast.includes(ui.pov) ? ui.pov : '', premise: ui.premise, text: '', createdAt: Date.now() };
  const messages = A.buildStoryMessages(state, { characterIds: story.characterIds, premise: ui.premise, length: ui.length, continueStory: existing, pov: story.pov });
  if (!existing) state.stories.push(story);
  else story.text += '\n\n';
  ui.busy = true; ui.currentId = story.id; ui.abort = new AbortController();
  go('write');
  setStatus('Writing…');
  const out = document.getElementById('output');
  out.textContent = story.text;
  try {
    await chat(messages, { signal: ui.abort.signal, onToken: (t) => { story.text += t; out.textContent = story.text; } });
  } catch (e) {
    if (e.name !== 'AbortError') { setStatus(e.message); if (!story.text.trim()) state.stories = state.stories.filter((s) => s !== story); finish(); return; }
  }
  story.text = story.text.trim();
  story.updatedAt = Date.now();
  await save();
  setStatus('Updating your world from this story…');
  try {
    const changes = A.applyWorldUpdate(state, story, await chatJson(A.buildWorldUpdateMessages(state, story)));
    await save();
    setStatus(changes.length ? 'World updated: ' + changes.join(', ') : 'Saved. Nothing new for the world this time.');
  } catch (e) {
    setStatus('Story saved, but the world update failed: ' + e.message);
  }
  finish();
}
function finish() { ui.busy = false; ui.abort = null; const s = ui.status; render(); setStatus(s); }

async function quickstart(vibe) {
  ui.busy = true; render(); setStatus('Dreaming up a world…');
  try {
    const added = A.applyQuickstart(state, await chatJson(A.buildQuickstartMessages(vibe)));
    ui.selected = added.map((c) => c.id);
    await save();
    ui.status = `Created ${state.world.name} with ${added.map((c) => c.name).join(', ')}. Hit Generate.`;
  } catch (e) { ui.status = e.message; }
  finish();
}

// ---------- views ----------
const PRESETS = {
  'Built-in (this device)': [BUILTIN, 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC'],
  'Built-in, lighter (phones)': [BUILTIN, LIGHT_MODEL],
  'OpenRouter: Venice Uncensored (free)': ['https://openrouter.ai/api/v1', 'venice/uncensored:free'],
  'OpenRouter: Euryale 70B (paid, best)': ['https://openrouter.ai/api/v1', 'sao10k/l3.3-euryale-70b'],
  'OpenRouter: GPT-4o mini': ['https://openrouter.ai/api/v1', 'openai/gpt-4o-mini'], 'OpenAI': ['https://api.openai.com/v1', 'gpt-4o-mini'],
  'Ollama (this PC)': ['http://localhost:11434/v1', 'llama3.1'], 'LM Studio (this PC)': ['http://localhost:1234/v1', 'local-model'],
};
const VIEWS = {
  write() {
    const story = ui.currentId && state.stories.find((s) => s.id === ui.currentId);
    const nodes = [];
    if (!state.settings.apiKey && state.settings.baseUrl !== BUILTIN && !/localhost|127\.0\.0\.1/.test(state.settings.baseUrl)) {
      // Phones get the lighter model by default: the 3B one needs ~3GB of GPU memory.
      const phone = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
      const useBuiltin = () => { Object.assign(state.settings, { baseUrl: BUILTIN, model: phone ? LIGHT_MODEL : PRESETS['Built-in (this device)'][1] }); save(); render(); };
      nodes.push(h('div', { class: 'card' }, h('h3', {}, 'First, connect an AI'),
        h('p', {}, 'Run a free storytelling model right on this device (one-time 1–2GB download), or add an API key in Settings.'),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: useBuiltin }, 'Use built-in model'), h('button', { class: 'btn ghost', onclick: () => go('settings') }, 'Add API key'))));
    }
    if (!state.characters.length) {
      const vibe = h('input', { placeholder: 'Optional: a one-line vibe, e.g. "rival witches in a rainy port city"' });
      nodes.push(h('h2', {}, 'Quick start'),
        h('p', { class: 'muted' }, 'Let the AI build a world and a starting cast for you. You can edit everything later.'),
        vibe, h('div', { class: 'row' }, h('button', { class: 'btn', disabled: ui.busy, onclick: () => quickstart(vibe.value.trim()) }, '✨ Create my world')),
        h('p', { class: 'muted' }, 'Or add your own characters in the Cast tab.'));
    } else {
      nodes.push(h('h2', {}, 'Who is in this story?'), h('p', { class: 'muted' }, 'Pick some, or none to use the whole cast.'),
        h('div', { class: 'chips' }, state.characters.map((c) => h('button', {
          class: 'chip' + (ui.selected.includes(c.id) ? ' on' : ''),
          onclick: () => { ui.selected = ui.selected.includes(c.id) ? ui.selected.filter((x) => x !== c.id) : [...ui.selected, c.id]; render(); },
        }, c.name))));
      const premise = h('textarea', { placeholder: 'Optional. Leave blank and the AI picks something that fits your world.', oninput: (e) => { ui.premise = e.target.value; } });
      premise.value = ui.premise;
      const length = h('select', { onchange: (e) => { ui.length = e.target.value; } },
        Object.entries(A.LENGTHS).map(([k, w]) => h('option', { value: k, selected: ui.length === k }, `${k[0].toUpperCase() + k.slice(1)} (~${w} words)`)));
      const castIds = ui.selected.length ? ui.selected : state.characters.map((c) => c.id);
      const pov = h('select', { onchange: (e) => { ui.pov = e.target.value; } },
        h('option', { value: '' }, 'Narrator (third person)'),
        state.characters.filter((c) => castIds.includes(c.id)).map((c) => h('option', { value: c.id, selected: ui.pov === c.id }, `${c.name} (first person)`)));
      nodes.push(...field('Premise or direction', premise), ...field('Length', length), ...field("Whose point of view?", pov),
        h('div', { class: 'row' },
          h('button', { class: 'btn', disabled: ui.busy, onclick: () => { ui.currentId = null; generate(); } }, '✨ Generate story'),
          ui.busy && h('button', { class: 'btn ghost', onclick: () => ui.abort && ui.abort.abort() }, 'Stop')));
    }
    nodes.push(h('div', { class: 'status', id: 'status' }, ui.status));
    if (story) {
      nodes.push(h('h2', {}, story.title), h('div', { class: 'prose', id: 'output' }, story.text));
      if (!ui.busy) nodes.push(h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => generate(story.id) }, 'Continue story'),
        h('button', { class: 'btn ghost', onclick: () => { ui.currentId = null; ui.premise = ''; ui.status = ''; render(); } }, 'New story')),
        h('p', { class: 'muted' }, 'Continue uses the Premise box above as direction for the next part, if you fill it in.'));
    } else if (ui.busy) nodes.push(h('div', { class: 'prose', id: 'output' }));
    return nodes;
  },

  stories() {
    if (ui.param) return storyReader(state.stories.find((s) => s.id === ui.param));
    const list = [...state.stories].sort((a, b) => b.createdAt - a.createdAt);
    if (!list.length) return [h('h2', {}, 'Stories'), h('div', { class: 'empty' }, 'No stories yet. Generate one from the Write tab.')];
    return [h('h2', {}, `Stories (${list.length})`), list.map((s) => h('div', { class: 'card', onclick: () => go('stories', s.id) },
      h('h3', {}, s.title),
      h('p', {}, [fmtDate(s.createdAt), (s.characterIds || []).map(charName).filter(Boolean).join(', ')].filter(Boolean).join(' · ')),
      s.summary && h('p', {}, s.summary)))];
  },

  characters() {
    if (ui.param) return characterEditor(ui.param === 'new' ? null : state.characters.find((c) => c.id === ui.param));
    return [h('h2', {}, `Cast (${state.characters.length})`),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => go('characters', 'new') }, '+ New character')),
      state.characters.length ? state.characters.map((c) => h('div', { class: 'card', onclick: () => go('characters', c.id) },
        h('h3', {}, c.name), h('p', {}, c.personality || c.background || ''),
        (c.developments || []).length > 0 && h('p', {}, `${c.developments.length} story developments`)))
        : h('div', { class: 'empty' }, 'No characters yet. Create one, or use Quick start on the Write tab.')];
  },

  world() {
    const w = state.world;
    const persist = () => { save(); document.getElementById('worldName').textContent = w.name; };
    const name = h('input', { value: w.name, oninput: (e) => { w.name = e.target.value; }, onchange: persist });
    const overview = h('textarea', { oninput: (e) => { w.overview = e.target.value; }, onchange: persist });
    overview.value = w.overview;
    const listBox = (key, label) => {
      const t = h('textarea', { rows: Math.min(12, Math.max(3, w[key].length + 1)), onchange: (e) => { w[key] = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); persist(); } });
      t.value = w[key].join('\n');
      return field(`${label} (${w[key].length}, one per line)`, t);
    };
    return [h('h2', {}, 'World'),
      h('p', { class: 'muted' }, 'This is the series bible. It grows automatically after every story, and every new story reads it. Edit freely.'),
      ...field('Name', name), ...field('Overview', overview),
      ...listBox('lore', 'Lore'), ...listBox('places', 'Places'), ...listBox('relationships', 'Relationships'), ...listBox('timeline', 'Timeline')];
  },

  settings() {
    const s = state.settings;
    const bind = (key, el) => { el.value = s[key]; el.addEventListener('change', () => { s[key] = el.value.trim(); save(); }); return el; };
    const base = bind('baseUrl', h('input', { placeholder: 'https://openrouter.ai/api/v1' }));
    const model = bind('model', h('input', { placeholder: 'model id' }));
    const preset = h('select', { onchange: (e) => { const p = PRESETS[e.target.value]; if (!p) return; s.baseUrl = p[0]; s.model = p[1]; save(); render(); } },
      h('option', { value: '' }, 'Pick a preset…'), Object.keys(PRESETS).map((k) => h('option', { value: k }, k)));
    const status = h('div', { class: 'status', id: 'status' });
    const test = async () => {
      status.textContent = 'Testing…';
      try { status.textContent = 'Works! Reply: ' + (await chat([{ role: 'user', content: 'Say hello in five words.' }], { stream: false })); } catch (e) { status.textContent = e.message; }
    };
    const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = A.normalizeState(JSON.parse(await f.text()));
        if (!confirm(`Replace your library with this backup (${data.stories.length} stories, ${data.characters.length} characters)?`)) return;
        if (!data.settings.apiKey) data.settings.apiKey = s.apiKey; // backups don't carry the key
        state = data; await save(); render();
      } catch (err) { alert('Could not read that file: ' + err.message); }
    } });
    const exportLib = () => {
      const data = JSON.parse(JSON.stringify(state));
      data.settings.apiKey = '';
      const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: `aetherstory-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a); a.click(); a.remove();
    };
    const style = h('textarea', { placeholder: 'e.g. slow-burn romance, second person, lots of banter, avoid gore' });
    bind('style', style);
    return [h('h2', {}, 'AI provider'),
      h('p', { class: 'muted' }, 'Any OpenAI-compatible API works. Your key is stored only on this device. Built-in presets run the AI on this device instead: no key, works offline after a one-time download, needs a browser with WebGPU.'),
      ...field('Preset', preset), ...field('Base URL', base), ...field('API key', bind('apiKey', h('input', { type: 'password', autocomplete: 'off', placeholder: 'sk-…' }))),
      ...field('Model', model), ...field('Creativity (temperature 0–2)', bind('temperature', h('input', { type: 'number', min: 0, max: 2, step: 0.1 }))),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: test }, 'Test connection')), status,
      h('h2', {}, 'Writing style'),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!s.mature, onchange: (e) => { s.mature = e.target.checked; save(); }, style: 'width:auto' }), ' Mature content (18+): explicit scenes allowed'),
      h('p', { class: 'muted' }, 'Hosted models like GPT-4o mini and the small built-in models often stay tame anyway; the Venice and Euryale presets follow it.'),
      ...field('Instructions applied to every story', style),
      h('h2', {}, 'Library'),
      h('p', { class: 'muted' }, `${state.stories.length} stories, ${state.characters.length} characters. Everything lives on this device; export to back up or move it to your phone/PC.`),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: exportLib }, 'Export backup'), h('button', { class: 'btn ghost', onclick: () => file.click() }, 'Import backup'), file)];
  },
};

function storyReader(story) {
  if (!story) return VIEWS.stories();
  return [h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => go('stories') }, '← All stories')),
    h('h2', {}, story.title),
    h('p', { class: 'muted' }, [fmtDate(story.createdAt), (story.characterIds || []).map(charName).filter(Boolean).join(', ')].filter(Boolean).join(' · ')),
    story.summary && h('p', { class: 'muted' }, story.summary),
    h('div', { class: 'prose' }, story.text),
    h('div', { class: 'row' },
      h('button', { class: 'btn', disabled: ui.busy, onclick: () => { ui.premise = ''; generate(story.id); } }, 'Continue story'),
      h('button', { class: 'btn danger', onclick: async () => { if (!confirm('Delete this story? Its effects on the world stay.')) return; state.stories = state.stories.filter((s) => s !== story); await save(); go('stories'); } }, 'Delete'))];
}

function characterEditor(c) {
  const draft = Object.assign({ name: '', appearance: '', personality: '', background: '', developments: [] }, c);
  const inputs = {};
  const mk = (key, label, area) => { inputs[key] = h(area ? 'textarea' : 'input', {}); inputs[key].value = draft[key]; return field(label, inputs[key]); };
  const dev = h('textarea', { rows: 4 });
  dev.value = (draft.developments || []).join('\n');
  const idea = h('input', { placeholder: 'Optional idea, e.g. "grumpy dragon-tamer with a soft spot for strays"' });
  const status = h('div', { class: 'status' });
  const aiFill = async (e) => {
    e.target.disabled = true; status.textContent = 'Imagining…';
    try {
      const r = await chatJson(A.buildCharacterMessages(state, idea.value.trim()));
      for (const k of ['name', 'appearance', 'personality', 'background']) if (r[k]) inputs[k].value = r[k];
      status.textContent = 'Review and Save.';
    } catch (err) { status.textContent = err.message; }
    e.target.disabled = false;
  };
  const saveChar = async () => {
    const vals = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
    if (!vals.name) { status.textContent = 'A name is required.'; return; }
    const target = c || { id: A.uid(), createdAt: Date.now() };
    Object.assign(target, vals, { developments: dev.value.split('\n').map((x) => x.trim()).filter(Boolean) });
    if (!c) state.characters.push(target);
    await save(); go('characters');
  };
  const appearsIn = c ? state.stories.filter((s) => (s.characterIds || []).includes(c.id)) : [];
  return [h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => go('characters') }, '← Cast')),
    h('h2', {}, c ? c.name : 'New character'),
    !c && [idea, h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: aiFill }, '✨ Fill in with AI'))],
    ...mk('name', 'Name'), ...mk('appearance', 'Appearance', true), ...mk('personality', 'Personality', true), ...mk('background', 'Background', true),
    ...field('Story developments (added automatically, one per line)', dev),
    status,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: saveChar }, 'Save'),
      c && h('button', { class: 'btn danger', onclick: async () => { if (!confirm(`Delete ${c.name}?`)) return; state.characters = state.characters.filter((x) => x !== c); ui.selected = ui.selected.filter((x) => x !== c.id); await save(); go('characters'); } }, 'Delete')),
    appearsIn.length > 0 && [h('h2', {}, 'Appears in'), appearsIn.map((s) => h('div', { class: 'card', onclick: () => go('stories', s.id) }, h('h3', {}, s.title), h('p', {}, s.summary || '')))]];
}

// ---------- boot ----------
(async () => {
  state = A.normalizeState(await load());
  let crashed = null;
  try { crashed = localStorage.getItem(CRASH_KEY); } catch (e) { /* private mode */ }
  if (crashed) {
    mark(null);
    if (state.settings.baseUrl === BUILTIN) ui.status = 'The built-in model crashed the page last time. ' + builtinOutOfMemory(state.settings.model);
  }
  // Anything that slips past a try/catch still shows up instead of failing silently.
  addEventListener('unhandledrejection', (e) => setStatus('Error: ' + ((e.reason && e.reason.message) || e.reason)));
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
