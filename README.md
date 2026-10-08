# Aetherstory

A personal AI story generator that remembers. Characters keep their history, every story is saved, and a shared "world bible" (lore, places, relationships, timeline) grows automatically after each story, so recurring characters build real continuity.

Everything runs in your browser and is stored on your device. There is no server and no account; use the built-in on-device model or bring your own AI key.

## Open it

**Phone or PC (recommended):** open the GitHub Pages link for this repo, then use your browser's *Install app* / *Add to Home Screen*. It then launches like a normal app.

**PC without hosting:** download the repo and double-click `index.html`.

Data is per device and per browser. To move your library between PC and phone, use **Settings → Export backup** on one and **Import backup** on the other.

## First run

1. **Settings:** pick a preset (OpenRouter is easiest: one key, many models), paste your API key, tap *Test connection*. For adult fiction, use the Euryale preset and tick *Mature content (18+)*.
2. **Write:** tap *Create my world* (optionally type a one-line vibe). The AI invents a world and a starting cast.
3. Pick characters, tap *Generate story*. Leave the premise blank and the AI chooses one that fits your world.

After each story the app asks the AI what changed and updates the world, the characters' "story developments", and adds any new recurring characters. The next story reads all of that.

## AI providers

Any OpenAI-compatible `/chat/completions` endpoint works: OpenRouter, OpenAI, or a local model through Ollama (`http://localhost:11434/v1`) or LM Studio (`http://localhost:1234/v1`). For Ollama, start it with `OLLAMA_ORIGINS=*` so the browser may call it.

**Built-in (no key):** the *Built-in* presets run [WebLLM](https://github.com/mlc-ai/web-llm) in the browser on your GPU. The default is Hermes 3 (Llama 3.2 3B), a small model tuned for creative writing and roleplay: ~2GB one-time download, then it works offline. *Built-in, lighter* uses Llama 3.2 1B (~1GB) and is the default on phones. If a device runs out of memory, the app switches to the lighter model and says so. Needs WebGPU: Chrome/Edge on PC or Android, Safari on iOS 26+. Quality is below big hosted models; switch presets any time.

## Development

No build step. `node --test` runs the logic tests in `test/`. Bump `VERSION` in `sw.js` when shipping changes so installed copies update.
