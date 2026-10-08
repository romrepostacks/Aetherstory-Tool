const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib.js');

function seeded() {
  const s = A.emptyState();
  s.characters.push({ id: 'a', name: 'Mira', personality: 'bold', developments: ['Lost her ship.'] });
  s.characters.push({ id: 'b', name: 'Toren', personality: 'wry', developments: [] });
  s.world.lore.push('Magic is fading.');
  s.stories.push({ id: 's1', title: 'The Wreck', summary: 'Mira loses her ship.', characterIds: ['a'], text: 'Old text.', createdAt: 1 });
  s.stories.push({ id: 's2', title: 'Unrelated', summary: 'Someone else.', characterIds: ['zz'], text: 'x', createdAt: 2 });
  return s;
}

test('story prompt carries world, characters and related past stories only', () => {
  const [sys, user] = A.buildStoryMessages(seeded(), { characterIds: ['a'], premise: 'a storm' });
  assert.match(sys.content, /Magic is fading/);
  assert.match(sys.content, /Mira/);
  assert.match(sys.content, /Lost her ship/);
  assert.match(sys.content, /The Wreck: Mira loses her ship/);
  assert.doesNotMatch(sys.content, /Unrelated/);
  assert.match(user.content, /Premise: a storm/);
  assert.match(user.content, /main characters are Mira/);
});

test('continuation sends the story tail and excludes itself from history', () => {
  const s = seeded();
  const [sys, user] = A.buildStoryMessages(s, { characterIds: ['a'], continueStory: s.stories[0] });
  assert.match(user.content, /Old text/);
  assert.doesNotMatch(sys.content, /The Wreck:/);
});

test('world update merges without duplicates and adds characters', () => {
  const s = seeded();
  const story = { id: 'n', title: 'Untitled story', characterIds: ['a'], text: 't' };
  const changes = A.applyWorldUpdate(s, story, {
    title: 'Storm Song', summary: 'Mira meets Kell.',
    characterUpdates: [{ name: 'mira', development: 'Found a new crew.' }, { name: 'Nobody', development: 'x' }],
    newCharacters: [{ name: 'Kell', personality: 'quiet' }, { name: 'Toren' }],
    lore: ['magic is fading.', 'Storms sing.'], places: 'not a list', timeline: ['Mira meets Kell'],
  });
  assert.equal(story.title, 'Storm Song');
  assert.deepEqual(s.characters[0].developments, ['Lost her ship.', 'Found a new crew.']);
  assert.equal(s.characters.length, 3);
  assert.equal(s.characters[2].name, 'Kell');
  assert.ok(story.characterIds.includes(s.characters[2].id));
  assert.deepEqual(s.world.lore, ['Magic is fading.', 'Storms sing.']);
  assert.deepEqual(s.world.places, []);
  assert.ok(changes.length >= 3);
  A.applyWorldUpdate(s, story, { characterUpdates: [{ name: 'Mira', development: 'found a new crew.' }] });
  assert.equal(s.characters[0].developments.length, 2);
});

test('quickstart builds world and cast', () => {
  const s = A.emptyState();
  const added = A.applyQuickstart(s, { name: 'Vel', overview: 'o', lore: ['l'], characters: [{ name: 'A' }, { name: 'a' }, {}] });
  assert.equal(s.world.name, 'Vel');
  assert.equal(added.length, 1);
});

test('parseJsonLoose handles fenced replies', () => {
  assert.deepEqual(A.parseJsonLoose('Sure!\n```json\n{"a": {"b": 1}}\n```'), { a: { b: 1 } });
  assert.throws(() => A.parseJsonLoose('nope'));
});

test('parseSSE splits tokens and keeps partial lines', () => {
  const chunk = 'data: {"choices":[{"delta":{"content":"He"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\ndata: {"choi';
  const r = A.parseSSE(chunk);
  assert.deepEqual(r.tokens, ['He', 'llo']);
  assert.equal(r.rest, 'data: {"choi');
  assert.equal(A.parseSSE('data: [DONE]\n').done, true);
});

test('normalizeState fills gaps from partial imports', () => {
  const s = A.normalizeState({ stories: [{ id: 1 }], world: { name: 'X' } });
  assert.equal(s.stories.length, 1);
  assert.deepEqual(s.world.lore, []);
  assert.equal(s.settings.temperature, 0.9);
});

test('relationships: newest state per pair replaces the old one and reaches the story prompt', () => {
  const s = seeded();
  s.world.relationships = ['Mira & Kell: strangers', 'Kell & Toren: brothers'];
  const story = { id: 'n', title: 'x', characterIds: ['a'], text: 't' };
  const changes = A.applyWorldUpdate(s, story, { relationships: ['Kell and Mira: secretly in love', 'Kell & Toren: brothers'] });
  assert.deepEqual(s.world.relationships, ['Kell & Toren: brothers', 'Kell and Mira: secretly in love']);
  assert.ok(changes.includes('1 relationships'));
  // older libraries kept every past state; only the latest is sent
  s.world.relationships = ['Mira & Kell: strangers', 'Mira & Kell: lovers'];
  const [sys, user] = A.buildStoryMessages(s, { characterIds: ['a'] });
  assert.match(user.content, /relationships right now.*Mira & Kell: lovers/);
  assert.doesNotMatch(sys.content + user.content, /strangers/);
});

test('point of view: first person for the chosen character', () => {
  const [, user] = A.buildStoryMessages(seeded(), { characterIds: ['a'], pov: 'a' });
  assert.match(user.content, /first person from Mira's point of view/);
  const [, plain] = A.buildStoryMessages(seeded(), { characterIds: ['a'] });
  assert.doesNotMatch(plain.content, /first person/);
});

test('relationships written in a character profile reach the story prompt', () => {
  const s = A.emptyState();
  s.characters.push({ id: 'a', name: 'Ana', background: 'Runs a bakery. Wife of Ben' }, { id: 'b', name: 'Ben', background: 'Ship captain. Husband of Ana.' });
  const [, user] = A.buildStoryMessages(s, { characterIds: ['a', 'b'] });
  assert.match(user.content, /Ana: Wife of Ben; Ben: Husband of Ana/);
  assert.doesNotMatch(user.content, /bakery\./);
});

test('mature setting adds the explicit-content instruction only when on', () => {
  const s = seeded();
  assert.doesNotMatch(A.buildStoryMessages(s, { characterIds: ['a'] })[0].content, /adult fiction/);
  s.settings.mature = true;
  assert.match(A.buildStoryMessages(s, { characterIds: ['a'] })[0].content, /adult fiction/);
});

test('a retired model id saved in settings is swapped for its replacement', () => {
  assert.equal(A.normalizeState({ settings: { model: 'venice/uncensored:free' } }).settings.model, A.emptyState().settings.model);
  assert.equal(A.normalizeState({ settings: { model: 'my/model' } }).settings.model, 'my/model');
});
