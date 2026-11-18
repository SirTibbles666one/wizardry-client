# Wizardry — state, next steps, and the upstream gap

18 November 2026 · client fork `SirTibbles666one/wizardry-client` · live at wizardry.slothlee.xyz

## 1. Where it stands

| Fact | Value | How known |
|---|---|---|
| Live web build | commit `5ff1e105`, `APP_NAME: Wizardry` | `build.json` on the domain |
| Site identity | `d = wizardry`, npub `npub1gpyh8nm3frn4hrfq8s25mytn5geeq050dl53ahht442ttcx6dapsmpxxzz` | the publish key |
| Site naddr | `naddr1qvzqqqyf8qpzqszfw08hzj88twxjq0q4fkgh8g3njqlg7mlfrm0wht25khsd5m6rqqy8w6t6v9exgunelz44a0` | `[web] nsite` on the relay |
| Publish key lives | this box, the relay, and the mail host (`/root/nsite-keys/`, 0600) | `ls -l` on all three |
| Fork point vs upstream | merge-base `64347cca` "Mount the Concord community page once per community" | `git merge-base` |
| Behind upstream | **80 commits**, latest **v0.69.8** (`3d83aa7e`, 18 Nov) | `git rev-list --count` |
| Ahead of upstream | **24 commits** (branding, account server, NIP-49, sealing) | `git rev-list --count` |
| Upstream churn since fork point | 317 files, +17,786 / −4,013 | `git diff --stat` |
| Files both sides edited | **26** (7 generated locale catalogs + 19 code/UI) | name-only diff intersection |
| Test suite | 735 files, ~7,900 tests; gate = tsc + eslint + i18n + vitest + 3 builds | `npm run test` |
| Published binaries | **0 releases** on the fork | GitHub releases API |
| `/downloads` trusts | upstream's signer `781a1527…` (build default) | `src/lib/releases.ts` |

The commands behind the table, for the next session:

- Live build and config: `curl -s https://wizardry.slothlee.xyz/build.json`
- Fork gap: `git merge-base HEAD upstream/main`, then `git rev-list --count HEAD..upstream/main` and `git rev-list --count upstream/main..HEAD`
- Upstream churn: `git diff --stat 64347cca..upstream/main`
- Releases: `curl -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/SirTibbles666one/wizardry-client/releases`

Two consequences worth stating plainly, because they are easy to miss:

- **`/downloads` currently hands out Armada.** With no release of our own, the page resolves releases signed by upstream's key, so an APK downloaded from our site is upstream's build with upstream's branding — not Wizardry, and without NIP-49 or the sealing work.
- **The app on a phone is older than the site.** Nothing in this session has shipped to Android or desktop; only the web build has.

## 2. What shipped this session

| Commit | What | Verified by |
|---|---|---|
| `0fe65b3e` | NIP-49 `ncryptsec`: log in with an encrypted key, back up with a password | NIP's own test vector, byte-compat with `nostr-tools` both ways, live browser unlock |
| `15ed4489` | Login list sealed at rest (AES-GCM-256, non-extractable IndexedDB key) | ciphertext on the live origin, session survives reload |
| `5ff1e105` | Settings › Account › Keys offers "Back up with a password" | 5 component tests, live build served |

## 3. What to do now, in order

### T1 — Merge upstream v0.69.8 (80 commits). The main job.

Expected cost: one careful session. Conflicts are **predictable, not unknown**: 7 of the 26 shared files are generated catalogs, and the code conflicts land in files where our changes are small and self-contained (`LoginScreen`, `BackupKeyDialog`, `KeyBackupSettings`), against upstream's large refactors elsewhere.

Do it as `git merge upstream/main` on a branch — never a rebase, which would replay 24 commits through 80 upstream ones and rewrite the published history.

### T2 — Decide the binary story.

Three options; each is a decision for the owner, not a technical preference:

1. **Build and publish our own APK + desktop**, signing releases with our own key and pointing `RELEASE_AUTHORS` at it. Real work: the fork's `applicationId` is still `buzz.armada.app`, and changing it later breaks Android App Links and in-place updates, so this is the moment to decide it.
2. **Point `RELEASE_AUTHORS` at our key and ship nothing yet** — `/downloads` then shows an honest empty state instead of upstream's binaries.
3. **Leave it** — simplest, and the only option that keeps handing people Armada.

Recommendation: **2 now, 1 when the upstream merge is settled** — publishing binaries from a tree that is 80 commits behind would bake today's gap into installs people cannot easily update.

### T3 — Seal the account session token (optional, ~1 hour).

`wizardry:account` still stores the account server's session token in plaintext. It is not the Nostr key, but it is the last readable credential in browser storage. It needs an async migration of a value `getAccountState()` reads synchronously today, so it is a small project, not a tweak.

### T4 — Prune the retired nsite (optional, 5 minutes).

The old `d = wizardry` naddr still resolves on gateways to the pre-rekey build. `nsyte delete --name … --dry-run` first; keep the blobs, since the live site references many of them.

## 4. The upstream gap, by theme

80 non-merge commits. Bucketed by subject, so the shape of the delta is visible before any code is read.

| Theme | Commits | What it means for us |
|---|---|---|
| Concord / communities | 24 | The deepest change: key delivery, rekey durability, access review, Channel topics, fold ordering. Mostly protocol-correctness work, no schema migration. |
| Other (releases, signer, invites, emoji, video) | 25 | Includes NIP-46 signer behaviour on app return, invite registry fixes, emoji pack grouping, video controls. |
| Messaging / timeline | 11 | Floating date header, jump-to-present fade, reply-preview quotes, DM arrival ordering fixes, timeline prepends during touch scroll. |
| Voice / media UX | 7 | Touch sheets for context menus, action dropdowns and call audio settings. Visibly different on a phone. |
| Profiles & avatars | 5 | One `DisplayName` path everywhere, avatar pulse/skeleton, community avatars on notifications. |
| Performance | 5 | Route changes as urgent updates, KV counters in profiling builds, member list mounted on first open. |
| Settings & UI chrome | 3 | Borderless cut-corner text fields; legacy settings copy ordering. |

**Stored-data risk: none.** Exactly one upstream commit touches `src/lib/db/` and it only counts KV reads in profiling builds — no migration, no key rename.

## 5. Merge plan

### Phase 0 — Preflight (10 min)

- Working tree clean; `git tag pre-upstream-2026-11-18`; branch `merge/upstream-v0.69.8`.
- Confirm the publish key is readable (`/data/.config/nsite/wizardry-nsec`) and the previous naddr is recorded above.
- `npm ci` on the pre-merge tree so a later failure is attributable to the merge, not to dependencies.

Pass: `git status` empty, tag exists, key present.

### Phase 1 — Merge and resolve (the bulk)

`git merge --no-commit upstream/main`, then resolve by class:

| Class | Files | Rule |
|---|---|---|
| Generated catalogs | the 7 `src/i18n/locales/*.json` | Take upstream's, then run `npm run i18n:extract` and `node scripts/i18n.mjs format`; our messages come back from the source, so the file is regenerated, not hand-merged. |
| Branding | `index.html`, `public/logo*.svg`, `public/favicon.svg`, `public/og.svg`, `src/themes.ts`, `src/lib/colorUtils.ts`, `public/theme.js`, `src/components/brand/*`, Android `crest_vector.xml` | Keep ours, then re-apply upstream's structural edits to `index.html` (CSP meta tag, boot-splash logic) by hand — the one file where "keep ours" is not enough. |
| Our NIP-49 surfaces | `LoginScreen.tsx`, `BackupKeyDialog.tsx`, `settings/KeyBackupSettings.tsx` | Take upstream's side, re-apply our hunks (imports, `unlockEncryptedKey`, the password blocks). Our changes are additive; dropping them silently is the one failure mode that ships quietly, so the Phase 2 probe exists to catch it. |
| Everything else | 300+ files | Upstream's. |

Pass: `git status` shows no unmerged paths; `git grep -c ncryptsec src` still finds our three surfaces.

### Phase 2 — Rebrand re-application

The mark is drawn in nine places (see the `armada-stack` skill). A merge that takes upstream's `index.html` wholesale reverts the boot splash silently, so this is a checklist, not a glance:

1. Page title and og/twitter tags say Wizardry.
2. Boot splash draws the sloth, not the crest.
3. `accent2` is sage in all three places (`colorUtils.ts`, `public/theme.js`, `index.html` fallback).
4. `APP_NAME=Wizardry` in the build env; wordmark renders `wizardry`.
5. Android splash vector still the sloth.

Pass: a rendered build shows "Wizardry" in the title and the sloth in the splash and tab.

### Phase 3 — Gate

`npm run test` (tsc, eslint, i18n check, full vitest, vite + electron + account-server builds), then the targeted probes below. Two flaky suites are known under full-suite load (`AccountServerSettings`, `useRekey`); re-run those alone before calling a failure real.

Pass: gate exit 0; `i18n: N messages, 7 catalogs complete`; suite green.

### Phase 4 — Publish and verify

Build with the live config, publish to the same naddr, then verify from outside:

- `build.json` on the domain names the new commit.
- A `ncryptsec` backup made by `nostr-tools` logs in on the live origin.
- Settings › Account › Keys shows "Back up with a password".
- `armada:login` is a sealed envelope and the session survives a reload.

Rollback: revert the merge commit and republish; armada keeps the previous nsite version, and `/etc/armada/armada.toml` has a timestamped backup beside it.

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Our NIP-49 hunks dropped in a conflicted file | Medium — three files, all conflicted | Phase 2 probe + `git grep ncryptsec` before publishing |
| Branding reverted by taking upstream's `index.html` | Medium | Phase 2 checklist, rendered check |
| Locale catalogs hand-merged and left inconsistent | High if hand-edited | Regenerate from source; never resolve a catalog by hand |
| Visual regressions from upstream's touch-sheet rework | Expected, not a defect | Accept as upstream's new design; review on a phone after merging |
| Publish from an uncommitted tree | Happened once this session | Build only from a clean, committed HEAD |

## 7. Open questions for the owner

1. **Android package id** — keep `buzz.armada.app` for App-Link compatibility, or move to our own id now and accept that installed copies cannot update in place? Everything else about T2 hangs on this.
2. **Touch-sheet UI** — upstream moved context menus, action dropdowns and call audio settings to bottom sheets on phones. That is a visible change to how Wizardry feels; accept it with the merge, or pin the old menus?
3. **Translation coverage for new upstream strings** — upstream ships 7 translations; anything new arrives translated, but any *our* copy that changed needs retranslating. Do you want plain English fallback allowed for a release, or is a complete catalog a hard gate?
