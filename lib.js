// Pure logic: prompt building, world merging, parsing. No DOM, so node can test it.
(function (root) {
  const LENGTHS = { short: 800, medium: 1500, long: 3000 };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function emptyState() {
    return {
      settings: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        temperature: 0.9,
        style: '',
        mature: false,
      },
      characters: [],
      stories: [],
      world: { name: 'My World', overview: '', lore: [], places: [], relationships: [], timeline: [] },
    };
  }

  // Models that stopped being offered under a saved id; swapped on load so old settings keep working.
  const RETIRED = { 'venice/uncensored:free': 'nvidia/nemotron-3-ultra-550b-a55b:free' };

  // Fill in anything missing so old exports / partial imports still load.
  function normalizeState(s) {
    const base = emptyState();
    s = s || {};
    return {
      settings: Object.assign(base.settings, s.settings, RETIRED[s.settings && s.settings.model] ? { model: RETIRED[s.settings.model] } : {}),
      characters: Array.isArray(s.characters) ? s.characters : [],
      stories: Array.isArray(s.stories) ? s.stories : [],
      world: Object.assign(base.world, s.world),
    };
  }

  function describeCharacter(c) {
    const lines = [`### ${c.name}`];
    for (const k of ['appearance', 'personality', 'background']) if (c[k]) lines.push(`${k[0].toUpperCase() + k.slice(1)}: ${c[k]}`);
    if (c.developments && c.developments.length) lines.push('Story so far: ' + c.developments.slice(-12).join(' '));
    return lines.join('\n');
  }

  // "Mira & Kell: rivals" -> "kell&mira", so a newer entry for the same pair replaces the old one.
  function pairKey(r) {
    const i = r.indexOf(':');
    return i < 0 ? null : r.slice(0, i).toLowerCase().split(/\s*(?:&|\band\b|,|\/)\s*/).map((s) => s.trim()).filter(Boolean).sort().join('&');
  }
  // Latest entry per pair wins (older libraries stored every past state).
  function currentRelationships(list) {
    const out = [];
    for (const r of list || []) {
      const k = pairKey(r);
      const i = k ? out.findIndex((x) => pairKey(x) === k) : -1;
      if (i >= 0) out.splice(i, 1);
      out.push(r);
    }
    return out;
  }

  function describeWorld(w) {
    const out = [`World: ${w.name || 'Unnamed'}`];
    if (w.overview) out.push(w.overview);
    for (const k of ['lore', 'places', 'relationships', 'timeline']) {
      const items = (k === 'relationships' ? currentRelationships(w[k]) : w[k] || []).slice(-40);
      if (items.length) out.push(`${k[0].toUpperCase() + k.slice(1)}:\n- ` + items.join('\n- '));
    }
    return out.join('\n\n');
  }

  // Past stories that share a character with this one, newest last.
  function relatedStories(state, characterIds, excludeId, limit = 10) {
    const ids = new Set(characterIds);
    return state.stories
      .filter((s) => s.id !== excludeId && s.summary && (!ids.size || (s.characterIds || []).some((id) => ids.has(id))))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-limit);
  }

  function buildStoryMessages(state, { characterIds = [], premise = '', length = 'medium', continueStory = null, pov = '' }) {
    const chars = state.characters.filter((c) => characterIds.includes(c.id));
    const past = relatedStories(state, characterIds, continueStory && continueStory.id);
    const system = [
      'You are a skilled fiction author writing an ongoing series set in one shared world.',
      'Keep characters, places and past events consistent with the series bible below. Build on earlier stories naturally (callbacks, evolving relationships) without recapping them.',
      'Write vivid prose with dialogue. Output only the story text: no preface, no notes, no title line.',
      state.settings.mature ? 'This is private adult fiction for a consenting adult reader. Sexual content is wanted: when the story calls for it, write it explicitly and in vivid detail instead of fading to black or softening it into a sweet romance.' : '',
      state.settings.style ? `Author guidelines from the reader: ${state.settings.style}` : '',
      '\n## Series bible\n' + describeWorld(state.world),
      chars.length ? '\n## Characters in this story\n' + chars.map(describeCharacter).join('\n\n') : '',
      past.length ? '\n## Earlier stories (oldest first)\n' + past.map((s) => `- ${s.title}: ${s.summary}`).join('\n') : '',
    ].filter(Boolean).join('\n');

    const words = LENGTHS[length] || LENGTHS.medium;
    // Repeated in the user turn: small on-device models skim the long system prompt and invent their own cast.
    const cast = chars.length ? ` The main characters are ${chars.map((c) => c.personality ? `${c.name} (${c.personality.split(/[.\n]/)[0].trim()})` : c.name).join(', ')}, ` +
      'existing characters from the series bible. Use them by these exact names and stay true to their descriptions; do not replace them with new characters.' : '';
    // Same reason: their relationships as they stand now, so the story picks up where the last one left off.
    const mentions = (text, c) => new RegExp(`\\b${c.name.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
    const rels = currentRelationships(state.world.relationships).filter((r) => chars.some((c) => mentions(r.slice(0, Math.max(r.indexOf(':'), 0)), c)));
    // Ties people wrote into a profile ("Wife of Ben") count too: any sentence naming another character in this story.
    for (const c of chars) {
      for (const line of `${c.background || ''}\n${c.personality || ''}`.split(/(?<=[.!?])\s+|\n/)) {
        if (line.trim() && chars.some((o) => o !== c && mentions(line, o))) rels.push(`${c.name}: ${line.trim().replace(/[.!?]$/, '')}`);
      }
    }
    const bonds = rels.length ? ` Their relationships right now (keep these consistent and let them evolve naturally): ${rels.join('; ')}.` : '';
    const narrator = state.characters.find((c) => c.id === pov);
    const voice = narrator ? ` Write it in first person from ${narrator.name}'s point of view: only what ${narrator.name} sees, thinks and feels.` : '';
    const guide = cast + bonds + voice;
    let user;
    if (continueStory) {
      user = `Here is the end of the story so far:\n\n"""${continueStory.text.slice(-6000)}"""\n\nContinue the story directly from where it stops for about ${words} words.${guide}` +
        (premise ? ` Direction for this part: ${premise}` : '');
    } else {
      user = `Write a new story of about ${words} words` +
        (chars.length ? ` featuring ${chars.map((c) => c.name).join(', ')}` : '') + '. ' +
        (premise ? `Premise: ${premise}` : 'Choose a fresh premise that fits the world and moves these characters forward.') + guide;
    }
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function buildWorldUpdateMessages(state, story) {
    const names = state.characters.map((c) => c.name).join(', ') || '(none yet)';
    const system = 'You maintain the continuity bible for a fiction series. Reply with JSON only, no markdown.';
    const user = `Current bible:\n${describeWorld(state.world)}\n\nKnown characters: ${names}\n\nNew story:\n"""${story.text.slice(-24000)}"""\n\n` +
      'Return JSON with exactly these keys:\n' +
      '{"title": "short evocative title", "summary": "2-3 sentence summary of what happened",\n' +
      ' "characterUpdates": [{"name": "known character", "development": "one sentence on what changed for them or what we learned"}],\n' +
      ' "newCharacters": [{"name": "", "appearance": "", "personality": "", "background": ""}],\n' +
      ' "lore": ["new world facts"], "places": ["Name: description"], "relationships": ["A & B: state of their relationship"], "timeline": ["event in one line"]}\n' +
      'relationships: for every pair whose relationship changed or was revealed in this story, give its CURRENT state (it replaces the old entry), e.g. "Mira & Kell: wary allies after the storm, unspoken attraction".\n' +
      'Otherwise only include NEW information not already in the bible. newCharacters only for named recurring-worthy characters not in the known list. Use empty arrays when nothing is new.';
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function buildCharacterMessages(state, idea) {
    const system = 'You create characters for a fiction series. Reply with JSON only, no markdown.';
    const user = `Series bible:\n${describeWorld(state.world)}\n\nExisting characters: ${state.characters.map((c) => c.name).join(', ') || '(none)'}\n\n` +
      `Create one new character${idea ? ` based on this idea: ${idea}` : ' who would fit this world and create interesting stories with the existing cast'}.\n` +
      'Return {"name": "", "appearance": "", "personality": "", "background": ""} with 1-3 sentences per field.';
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function buildQuickstartMessages(vibe) {
    const system = 'You design settings for fiction series. Reply with JSON only, no markdown.';
    const user = `Invent a story world and a starting cast${vibe ? ` from this idea: ${vibe}` : ' with strong potential for character-driven, emotional stories'}.\n` +
      'Return {"name": "world name", "overview": "one paragraph", "lore": ["3-5 facts"], "places": ["Name: description" x3],\n' +
      ' "characters": [{"name": "", "appearance": "", "personality": "", "background": ""} x2-3], "relationships": ["A & B: how they relate"]}';
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  // Mutates state with a freshly generated world + cast. Returns the new characters.
  function applyQuickstart(state, q) {
    const w = state.world;
    if (str(q.name)) w.name = str(q.name);
    if (str(q.overview)) w.overview = str(q.overview);
    for (const k of ['lore', 'places', 'relationships']) mergeList(w[k], strList(q[k]));
    const added = [];
    for (const c of Array.isArray(q.characters) ? q.characters : []) {
      if (!c || !str(c.name) || state.characters.some((x) => x.name.toLowerCase() === str(c.name).toLowerCase())) continue;
      const nc = { id: uid(), name: str(c.name), appearance: str(c.appearance), personality: str(c.personality), background: str(c.background), developments: [], createdAt: Date.now() };
      state.characters.push(nc);
      added.push(nc);
    }
    return added;
  }

  // Models sometimes wrap JSON in prose or ``` fences; grab the outermost object.
  function parseJsonLoose(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('No JSON object in model reply');
    return JSON.parse(text.slice(start, end + 1));
  }

  const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  function mergeList(list, items) {
    const seen = new Set(list.map((x) => x.toLowerCase()));
    for (const it of items) if (!seen.has(it.toLowerCase())) { list.push(it); seen.add(it.toLowerCase()); }
  }
  // Like mergeList, but a pair's new state replaces its old one. Returns how many entries changed.
  function mergeRelationships(list, items) {
    let n = 0;
    for (const it of items) {
      if (list.some((x) => x.toLowerCase() === it.toLowerCase())) continue;
      const k = pairKey(it);
      for (let i = list.length - 1; i >= 0; i--) if (k && pairKey(list[i]) === k) list.splice(i, 1);
      list.push(it); n++;
    }
    return n;
  }

  // Mutates state. Returns a short human summary of what changed.
  function applyWorldUpdate(state, story, u) {
    const changes = [];
    if (str(u.title)) story.title = str(u.title);
    if (str(u.summary)) story.summary = str(u.summary);
    const byName = (n) => state.characters.find((c) => c.name.toLowerCase() === n.toLowerCase());

    for (const cu of Array.isArray(u.characterUpdates) ? u.characterUpdates : []) {
      const c = cu && byName(str(cu.name));
      if (c && str(cu.development)) {
        const before = (c.developments = c.developments || []).length;
        mergeList(c.developments, [str(cu.development)]);
        if (c.developments.length > before) changes.push(`${c.name} developed`);
      }
    }
    for (const nc of Array.isArray(u.newCharacters) ? u.newCharacters : []) {
      const name = nc && str(nc.name);
      if (!name || byName(name)) continue;
      const c = { id: uid(), name, appearance: str(nc.appearance), personality: str(nc.personality), background: str(nc.background), developments: [], createdAt: Date.now() };
      state.characters.push(c);
      if (!story.characterIds.includes(c.id)) story.characterIds.push(c.id);
      changes.push(`new character ${name}`);
    }
    for (const k of ['lore', 'places', 'timeline']) {
      const before = state.world[k].length;
      mergeList(state.world[k], strList(u[k]));
      if (state.world[k].length > before) changes.push(`${state.world[k].length - before} ${k}`);
    }
    const rel = mergeRelationships(state.world.relationships, strList(u.relationships));
    if (rel) changes.push(`${rel} relationships`);
    return changes;
  }

  // Split an SSE buffer into complete `data:` payloads plus the unfinished tail.
  function parseSSE(buffer) {
    const lines = buffer.split('\n');
    const rest = lines.pop();
    const tokens = [];
    let done = false;
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') { done = true; continue; }
      try {
        const d = JSON.parse(data);
        const tok = d.choices && d.choices[0] && ((d.choices[0].delta && d.choices[0].delta.content) || (d.choices[0].message && d.choices[0].message.content));
        if (tok) tokens.push(tok);
      } catch (e) { /* keep-alive or partial junk */ }
    }
    return { tokens, rest, done };
  }

  const api = { LENGTHS, uid, emptyState, normalizeState, buildStoryMessages, buildWorldUpdateMessages, buildCharacterMessages, buildQuickstartMessages, applyQuickstart, parseJsonLoose, applyWorldUpdate, parseSSE, describeWorld, currentRelationships };
  root.Aether = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
