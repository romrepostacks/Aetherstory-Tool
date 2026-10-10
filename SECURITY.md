# Security and privacy

Aetherstory holds some of the most private things a person can write. The goal: **nothing a user writes ever leaves their control without them knowing exactly where it goes.**

This file is the living record of how the app protects its users. **Every change that touches stored data, network requests, backups or hosting must update this file in the same pull request.**

## Where data lives

| Data | Where | Protection |
|---|---|---|
| Stories, characters, world | IndexedDB in the user's browser (localStorage if IndexedDB is unavailable) | Browser same-origin isolation. **Not encrypted at rest yet** (see Roadmap). |
| AI API key | Same record as the library | Never written into backups. Same at-rest caveat. |
| Device backup key (AES-256) | Its own IndexedDB record, outside the library | Never written into backups. Downloaded only when the user taps *Download key*. |
| Backup files | Wherever the user saves them | AES-256-GCM with the device key. Tampering or a wrong key is detected and refused. |
| Age confirmation | In the library settings | Not sensitive. |

There is no server, account system, analytics, telemetry, crash reporting or third-party script. The app is static files on GitHub Pages.

## What leaves the device

1. **Story requests to the AI provider the user picks** (OpenRouter by default). The prompt contains the selected characters' profiles, the world notes and the story so far. This is the one unavoidable flow: the AI cannot write without reading. Who can see it:
   - **OpenRouter** relays it. Users should keep prompt logging off in their OpenRouter privacy settings.
   - **The model's provider** runs it. Free models are often served by providers that may keep or train on prompts, which is why OpenRouter makes free models a separate opt-in in its privacy settings. **Private mode** (Settings) adds `provider.data_collection = "deny"`, so OpenRouter only routes to providers that don't store or train on prompts. Some free models stop working when it's on.
2. **Loading the app** from GitHub Pages. GitHub sees the visitor's IP address like any web host. No story data is involved.
3. Nothing else. The Content Security Policy blocks scripts from anywhere but the app itself.

## Protections in place

- **Encrypted backups:** AES-256-GCM through WebCrypto, with a random 256-bit key per device and a fresh 96-bit IV per export. A backup from another device needs that device's key file (`aetherstory-key.txt`). The API key is never exported.
- **Imports can't hijack the AI key:** importing a backup never changes this device's AI address, key, model or Private mode. A crafted backup therefore can't send this device's key to a server the attacker controls.
- **Content Security Policy:** scripts run only from the app's own origin. No inline scripts, no `eval`, no plugins, no forms.
- **Safe rendering:** all story and character text is inserted as text nodes. No `innerHTML` anywhere, so model output and imported data can't inject code.
- **Erase everything** (Settings): deletes the library, the API key, the device key, every offline cache and the service worker on this device.
- **No referrer** is sent to linked sites, and search engines are told not to index the app.
- **App switcher blur:** the screen blurs when the app is hidden. This is best effort, because some browsers take the preview snapshot first.
- **18+ gate** on first launch, and mature content clearly labelled.
- **No third-party runtime code.** The on-device model loader from a CDN was removed on 2026-10-10.

## Audit log

### 2026-10-10: full audit before the guided-setup release (PR #9)

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | Story text goes to the AI provider, and free providers may keep or train on it. | **Partly fixed:** Private mode added. Whether it is on by default is waiting on the owner. |
| 2 | High | The library and API key are stored unencrypted on the device. Anyone who can open the browser, or copy its profile, can read every story. | **Open:** app lock (see Roadmap). |
| 3 | High | The repository is public. An earlier PR description once contained real character details. It was redacted, but GitHub keeps description edit history, and commits that were overwritten stay reachable by their ID. | **Owner action needed:** see the owner checklist below. A check of the current files, every commit on every branch, and all PR descriptions and comments found no personal details today. |
| 4 | High | Supply chain: anyone who can push to `main` ships code to every user's device on the next load, and that code could read the library. | **Owner action needed:** 2FA and branch protection. Workflow actions are pinned to major tags rather than commit SHAs. |
| 5 | Medium | Importing a crafted backup could change the AI address while keeping this device's key, sending the key to an attacker's server. | **Fixed** |
| 6 | Medium | No Content Security Policy. | **Fixed** |
| 7 | Medium | No way to wipe all data from a device. | **Fixed:** Erase everything. |
| 8 | Medium | The app switcher preview could show a story. | **Mitigated:** blur when hidden. |
| 9 | Low | Plain-text backups were the only format. | **Fixed:** exports are always encrypted. Old plain backups can still be imported. |
| 10 | Low | Referrer header and search indexing. | **Fixed** |
| 11 | Info | XSS review: rendering uses `createElement`/text nodes only, and there is no `innerHTML`, `eval` or dynamic script loading. | OK |
| 12 | Info | The device backup key sits in the same browser storage as the library. It protects backup files, not the device itself. | By design: the app lock will wrap it. |

## Roadmap (next protections, in priority order)

1. **App lock with a passcode.** Encrypt the whole library and API key at rest with AES-256-GCM, using a key derived from a passcode (PBKDF2-SHA256, 600k iterations). The app opens to a lock screen. A forgotten passcode means the data is gone unless a backup and key file exist. This closes findings 2 and 12.
2. **Auto-lock** after a few minutes in the background.
3. **Pin GitHub Actions to commit SHAs** and enable branch protection on `main`.
4. **Self-host or reconsider public hosting.** A private repository removes all public history, but Pages on a private repo needs a paid GitHub plan.

## Owner checklist (things only the repo owner can do)

- [ ] On PR #5, open the "edited" menu on the description and **delete every older revision**.
- [ ] Turn on **two-factor authentication** for the GitHub account.
- [ ] Add a **branch protection rule** on `main` that requires a pull request.
- [ ] In OpenRouter **Settings → Privacy**, keep prompt logging off.
- [ ] Never commit real names, profiles or story text. Tests and docs use made-up names.

## User guidance (shown in the app where it matters)

- Download your device key once and keep it apart from your backups.
- Use a device passcode, because anyone holding an unlocked phone can open the app.
- Turn on Private mode if you'd rather a story fail than reach a provider that might keep it.

## Reporting a problem

Open a private security advisory on this repository (Security → Advisories → Report a vulnerability). Please don't open a public issue for security problems.

*This document describes technical safeguards. It is not legal advice and doesn't by itself establish compliance with any specific law.*
