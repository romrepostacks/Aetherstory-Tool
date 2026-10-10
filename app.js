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
// Reads `key`, or writes it when a value is given.
async function kv(key, value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
    const q = value === undefined ? t.objectStore('kv').get(key) : t.objectStore('kv').put(value, key);
    t.oncomplete = () => res(q.result);
    t.onerror = () => rej(t.error);
  });
}
async function load() {
  try {
    return await kv('state');
  } catch (e) {
    return JSON.parse(localStorage.getItem(DB_KEY) || 'null');
  }
}
// This device's backup key, made on first use. Kept outside the library so it never ends up inside a backup.
let devKey = null;
const deviceKey = () => devKey || (devKey = (async () => {
  try {
    let k = await kv('deviceKey');
    if (!k) await kv('deviceKey', k = A.newKey());
    return k;
  } catch (e) {
    const k = localStorage.getItem(DB_KEY + '-key') || A.newKey();
    localStorage.setItem(DB_KEY + '-key', k);
    return k;
  }
})());
async function save() {
  const data = JSON.parse(JSON.stringify(state));
  try {
    await kv('state', data);
  } catch (e) {
    try { localStorage.setItem(DB_KEY, JSON.stringify(data)); } catch (e2) { alert('Could not save: ' + e2.message + '\nExport your library from Settings.'); }
  }
}

// ---------- AI ----------
async function chat(messages, { onToken, signal, stream = true } = {}) {
  const s = state.settings;
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
const ui = { advanced: false, pendingImport: null, view: 'write', param: null, selected: [], premise: '', length: 'medium', pov: '', busy: false, status: '', currentId: null, abort: null };
const TABS = [['write', '✍️', 'Write'], ['stories', '📚', 'Stories'], ['characters', '🎭', 'Cast'], ['world', '🌍', 'World'], ['settings', '⚙️', 'Settings']];

function go(view, param = null) { ui.view = view; ui.param = param; render(); window.scrollTo(0, 0); }

function render() {
  document.getElementById('worldName').textContent = state.world.name;
  const nav = document.getElementById('nav');
  const view = document.getElementById('view');
  nav.hidden = !state.settings.ageOk;
  if (!state.settings.ageOk) return view.replaceChildren(...ageGate());
  nav.replaceChildren(...TABS.map(([v, icon, label]) => h('button', { class: ui.view === v ? 'on' : '', onclick: () => go(v) }, h('span', {}, icon), label)));
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
  'OpenRouter: Nemotron 3 Ultra (free, default)': ['https://openrouter.ai/api/v1', 'nvidia/nemotron-3-ultra-550b-a55b:free'],
  'OpenRouter: Gemma 4 31B (free)': ['https://openrouter.ai/api/v1', 'google/gemma-4-31b-it:free'],
  'OpenRouter: Venice Uncensored (paid, under 1¢ a story)': ['https://openrouter.ai/api/v1', 'cognitivecomputations/dolphin-mistral-24b-venice-edition'],
  'OpenRouter: Euryale 70B (paid, best)': ['https://openrouter.ai/api/v1', 'sao10k/l3.3-euryale-70b'],
  'Ollama (this PC)': ['http://localhost:11434/v1', 'llama3.1'], 'LM Studio (this PC)': ['http://localhost:1234/v1', 'local-model'],
};
// Guided setup for someone who has never made an API key: three steps, one paste, then straight to writing.
function keySetup() {
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste your key here' });
  const status = h('div', { class: 'status' });
  const start = async () => {
    const k = key.value.trim();
    if (!k) { status.textContent = 'Paste your key first.'; return; }
    const d = A.emptyState().settings;
    Object.assign(state.settings, { apiKey: k, baseUrl: d.baseUrl, model: d.model });
    await save();
    status.textContent = 'Checking your key…';
    try { await chat([{ role: 'user', content: 'Say hi.' }], { stream: false }); } catch (e) { status.textContent = 'That key did not work. Check you copied all of it. (' + e.message + ')'; return; }
    ui.status = 'You are all set!'; go('write');
  };
  return [h('ol', { class: 'steps' },
    h('li', {}, 'Open ', h('a', { href: 'https://openrouter.ai/keys', target: '_blank', rel: 'noopener' }, 'openrouter.ai/keys'), ' and sign in. Google sign-in works, and no card is needed.'),
    h('li', {}, 'Tap ', h('b', {}, 'Create API Key'), ', name it anything (like "stories"), and tap ', h('b', {}, 'Copy'), '.'),
    h('li', {}, 'Come back here, paste it below, and tap Start.')),
    key, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: start }, 'Start')), status];
}
function ageGate() {
  return [h('h2', {}, 'Adults only (18+)'),
    h('p', {}, 'Aetherstory writes fiction that can include explicit sexual content, violence and other mature themes. You must be at least 18 years old, or the age of majority where you live, to use it.'),
    h('p', { class: 'muted' }, 'By entering, you confirm you meet this age requirement and choose to view this kind of content.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { state.settings.ageOk = true; save(); render(); } }, 'I am 18 or older'),
      h('button', { class: 'btn ghost', onclick: () => { location.href = 'https://www.google.com'; } }, 'Leave'))];
}
const VIEWS = {
  write() {
    const story = ui.currentId && state.stories.find((s) => s.id === ui.currentId);
    const nodes = [];
    if (!state.settings.apiKey && !/localhost|127\.0\.0\.1/.test(state.settings.baseUrl)) {
      nodes.push(h('div', { class: 'card setup' }, h('h3', {}, 'First, get your free AI key'),
        h('p', {}, 'It takes about two minutes and costs nothing. You only do this once.'), keySetup()));
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
    const restore = async (raw) => {
      const data = A.normalizeState(raw);
      if (!confirm(`Replace your library with this backup (${data.stories.length} stories, ${data.characters.length} characters)?`)) return;
      if (!data.settings.apiKey) data.settings.apiKey = s.apiKey; // backups don't carry the API key
      data.settings.ageOk = true;
      state = data; ui.pendingImport = null; await save(); render();
    };
    const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!A.isEncrypted(j)) return await restore(j); // older, unencrypted backups still load
        let plain;
        try { plain = await A.decryptBackup(j, await deviceKey()); } catch (err) { ui.pendingImport = j; render(); return; }
        await restore(plain);
      } catch (err) { alert('Could not read that file: ' + err.message); }
    } });
    const download = (text, name) => {
      const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' })), download: name });
      document.body.append(a); a.click(); a.remove();
    };
    const exportLib = async () => {
      const data = JSON.parse(JSON.stringify(state));
      data.settings.apiKey = '';
      download(JSON.stringify(await A.encryptBackup(data, await deviceKey())), `aetherstory-${new Date().toISOString().slice(0, 10)}.json`);
    };
    // A backup from another device: ask for that device's key file (or the pasted key).
    const unlockBox = () => {
      const msg = h('div', { class: 'status' });
      const unlock = async (key) => {
        let plain;
        try { plain = await A.decryptBackup(ui.pendingImport, key); } catch (err) { msg.textContent = 'That key does not open this backup. Use the key file from the device that made it.'; return; }
        await restore(plain);
      };
      const keyFile = h('input', { type: 'file', accept: '.txt,text/plain', onchange: async (e) => { const f = e.target.files[0]; if (f) unlock(await f.text()); } });
      const pasted = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Or paste the key' });
      return h('div', { class: 'card setup' }, h('h3', {}, 'This backup was made on another device'),
        h('p', {}, 'Choose the key file you downloaded on that device (aetherstory-key.txt) to unlock it.'),
        ...field('Key file', keyFile), pasted,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => unlock(pasted.value) }, 'Unlock'), h('button', { class: 'btn ghost', onclick: () => { ui.pendingImport = null; render(); } }, 'Cancel')), msg);
    };
    const style = h('textarea', { placeholder: 'e.g. slow-burn romance, second person, lots of banter, avoid gore' });
    bind('style', style);
    const isDefault = s.model === A.emptyState().settings.model;
    return [h('h2', {}, 'AI setup'),
      s.apiKey ? [h('p', { class: 'muted' }, '✓ Key saved. ' + (isDefault ? 'Stories are written by the free default AI (Nemotron).' : `Using ${s.model} (see Advanced mode).`)),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: test }, 'Test it'))]
        : keySetup(),
      h('details', { open: ui.advanced, ontoggle: (e) => { ui.advanced = e.target.open; } }, h('summary', {}, 'Advanced mode'),
        h('p', { class: 'muted' }, 'Pick another model or any OpenAI-compatible service. Your key is stored only on this device.'),
        ...field('Preset', preset), ...field('Base URL', base), ...field('API key', bind('apiKey', h('input', { type: 'password', autocomplete: 'off', placeholder: 'sk-…' }))),
        ...field('Model', model), ...field('Creativity (temperature 0–2)', bind('temperature', h('input', { type: 'number', min: 0, max: 2, step: 0.1 }))),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: test }, 'Test connection'))),
      status,
      h('h2', {}, 'Writing style'),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!s.mature, onchange: (e) => { s.mature = e.target.checked; save(); }, style: 'width:auto' }), ' Mature content (18+): explicit scenes allowed'),
      h('p', { class: 'muted' }, 'Free models may still soften some scenes. Venice and Euryale (paid, in Advanced mode) follow it most reliably.'),
      ...field('Instructions applied to every story', style),
      h('h2', {}, 'Library'),
      h('p', { class: 'muted' }, `${state.stories.length} stories, ${state.characters.length} characters. Everything lives on this device; export to back up or move it to your phone/PC.`),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: exportLib }, 'Export backup'), h('button', { class: 'btn ghost', onclick: () => file.click() }, 'Import backup'),
        h('button', { class: 'btn ghost', onclick: async () => download(await deviceKey(), 'aetherstory-key.txt') }, 'Download key'), file),
      h('p', { class: 'muted' }, 'Backups are encrypted (AES-256) with a key unique to this device. To open one on another device, or after clearing this browser, you also need this device\'s key file: download it once and keep it somewhere separate from your backups.'),
      ui.pendingImport && unlockBox()];
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
  // Anything that slips past a try/catch still shows up instead of failing silently.
  addEventListener('unhandledrejection', (e) => setStatus('Error: ' + ((e.reason && e.reason.message) || e.reason)));
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
