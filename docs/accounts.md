# Wizardry accounts

Wizardry asks for an email and a password. Behind that account sits a Nostr key, and the account
server is built so that it cannot tell which Nostr identity belongs to which email, cannot read
the key, and never learns the password.

This is Wizardry's own layer on top of the client (`src/account/`). With `ACCOUNT_SERVER` unset
the client behaves exactly as upstream does: key-only login, no server.

## What the server holds

| Thing | What is stored | What that means |
|---|---|---|
| Email | `HMAC(pepper, email)` | The address is used once, in memory, to send a code. It is never written down or logged. |
| Password | nothing | The device stretches it (scrypt, 2^16) and sends one derived key, `authKey`. The server stores `HMAC(pepper, salt ‖ authKey)`. |
| Nostr secret key | a locked vault | Encrypted on the device (XChaCha20-Poly1305) under a second derived key that never leaves it. Fixed length. |
| Recovery | a second locked vault | The same key, encrypted under the recovery code shown once at sign-up. |
| Nostr public key | `HMAC(pepper, pubkey)` | In a table with **no account column**, dated to the day. It answers "is this key a member's?" and nothing else. |
| Sessions, codes | hashes with expiry | A stolen database holds no usable token or code. |

`pepper` is a 32-byte secret in the server's environment, not in the database.

```
password ──scrypt(salt)──► master ──HKDF "auth"──► authKey    → server (hashed again there)
                                   └─HKDF "vault"─► vaultKey   → stays on the device
recovery code ──scrypt──► … same split … ► recoveryAuth / recoveryVaultKey
```

A hash of a secret key cannot be turned back into the key, so "hash the key" alone would mean
pasting the key into every new device. The vault is what makes email + password enough to sign in
anywhere, and the hash is what keeps the identity unnamed.

## What this protects against, and what it does not

- **A copy of the database** shows hashes and ciphertext. No address, no public key, no way to pair
  an account with a Nostr identity. Guessing a password offline needs the pepper as well.
- **The database and the pepper together** let an attacker test a *known* email or a *known* public
  key against the tables, and guess weak passwords at scrypt cost. Public keys are public on
  relays, so with the pepper a determined attacker could test every key they have seen. They still
  could not pair a key with an email from the tables: nothing joins them.
- **The operator, live.** A server that wanted to cheat could log an address as it arrives, or note
  that an account and a key hash were written in the same second. The code does neither, the build
  is one readable file, and `key_hashes` keeps the day only. That is a promise about the code that
  runs, not a mathematical guarantee. Signing in over Tor or a VPN removes the IP from the picture.
- **Not protected:** a weak password, a device with malware, or someone who has both the mailbox
  and the recovery code.

## Forgotten password

- **With the recovery code:** emailed code + recovery code opens the recovery vault on the device,
  the key is re-locked under the new password, and a new recovery code is issued. Old sessions end.
- **Without it:** the emailed code keeps the account but empties it. The old key is gone. That is
  the price of a server that cannot read keys, and the sign-up screen has to say so plainly.

## Keys people already have

An account may hold a key Wizardry made, or one pasted in as an `nsec`; both go in the vault. A
browser-extension or remote-signer (bunker) key is never seen by Wizardry at all: it is linked by
hash only, after signing a NIP-98 proof, and the person keeps signing in to it their own way.

## Endpoints

All `POST /v1/<route>`, JSON. Errors are `{ "error": "<code>" }`.

| Route | Needs | Does |
|---|---|---|
| `prelogin` | email | Returns the KDF salt. Answers for every address (a stable decoy for unknown ones). |
| `signup` | email, salt, authKey | Mails a six-digit code. A taken address gets the same answer, and its owner gets a notice. |
| `verify` | email, authKey, code | Confirms the address and opens a session. |
| `login` | email, authKey | Session, plus the vault if there is one. |
| `vault/put` | session | Stores vault + recovery bundle together, or clears both. |
| `key/link`, `key/unlink` | session, signed proof | Adds or removes the public key's hash. |
| `password/change` | session, old authKey | New verifier and re-sealed vault in one request. |
| `recover/start` | email | Mails a code if the account exists; same answer either way. |
| `recover/salt`, `recover/open`, `recover/reset` | codes | The recovery flow above. |
| `recover/start-over` | email, code | Keeps the account, drops the key. |
| `account/delete` | session, authKey | Removes the account. |
| `member/check` | `x-member-token` | For a members-only relay: is this public key a member's? |

Limits: codes last 15 minutes and take five tries; sign-in is limited per address and per caller;
sessions last 30 days.

## Running it

```sh
npm run build:account-server          # → server/account-server.mjs, one file, no install
ACCOUNT_PEPPER=$(openssl rand -hex 32) \
ACCOUNT_PUBLIC_URL=https://accounts.example.com \
ACCOUNT_ALLOWED_ORIGINS=https://wizardry.example.com \
SMTP_URL='smtps://user:password@mail.example.com:465' \
MAIL_FROM='Wizardry <hello@example.com>' \
node server/account-server.mjs
```

| Setting | Meaning |
|---|---|
| `ACCOUNT_PEPPER` | 64+ hex characters. **Back it up apart from the database.** Lose it and every account is unusable; leak it with the database and the hashes can be tested. |
| `ACCOUNT_PUBLIC_URL` | The origin clients reach it on. Key proofs must name it. |
| `ACCOUNT_ALLOWED_ORIGINS` | Comma-separated web origins allowed to call it (`*` for any). |
| `ACCOUNT_DB` | SQLite path. Default `accounts.db`. |
| `SMTP_URL`, `MAIL_FROM` | Submission server. `smtps://` is TLS; a password is refused over plain `smtp://` except to localhost. |
| `ACCOUNT_DEV_MAIL=console` | Local development: print the code's subject line instead of sending. |
| `ACCOUNT_TRUSTED_PROXIES` | How many reverse proxies are in front, so rate limits see the real caller. |
| `ACCOUNT_MEMBER_TOKEN` | Shared secret for `member/check`. Unset disables it. |
| `HOST`, `PORT` | Default `127.0.0.1:8787`; put TLS in front with the reverse proxy. |

The client turns accounts on when its `ACCOUNT_SERVER` setting names the server's origin.

## Status

Built and tested (`src/account/**/*.test.ts`): the protocol, the client-side cryptography, the API
client, the server rules, the SQLite store, and the mailer against a local SMTP server. The bundle
has been started and called over HTTP.

Not built yet — see the plan below.

# The plan

## 1. Accounts in the app (next)

1. **The gate.** With `ACCOUNT_SERVER` set, the first screen is email + password: *Sign in*,
   *Create account*, *Forgot password*. Key-only login moves behind the account, as "use a key I
   already have".
2. **Sign-up.** Email and password → six-digit code → choose: make me a key (default), paste my
   `nsec`, or connect an extension or signer → **recovery code screen** that will not continue until
   the code is copied or downloaded, and says what losing it costs.
3. **Sign-in on a new device.** Email + password → the vault opens on the device → the existing
   login is created from it. No key ever typed.
4. **Settings › Account.** Change password, show whether a key and a recovery code are stored,
   make a new recovery code, remove the stored key, delete the account.
5. **Sign-out** ends the server session as well as the local login.
6. All of it translated into the eight languages, as the repo requires.

Then: Android and iOS keep the unlocked key in the platform's secure storage as they do today; the
account password is asked for again only when the vault must be re-sealed.

## 2. Deployment

- Run the account server beside the mail server, behind the existing reverse proxy, on its own
  hostname. A systemd unit and a backup line for `accounts.db` and the pepper (kept apart).
- Send through the mail server you already run; a proper SPF/DKIM-aligned From address so codes do
  not land in spam.
- Optional: a members-only relay that calls `member/check` on NIP-42 AUTH, so the email gate is
  real for the community's own rooms and not just a screen in one client.

## 3. Finishing the rebrand

The mark, the copy and the hosted site say Wizardry. Still Armada underneath:

- **Defaults:** `APP_NAME` falls back to "Armada" in `src/lib/platform.ts`, and the desktop shell
  hard-codes it in window and tray titles. `APP_ID` is `armada` — changing that one moves where
  settings are stored, so it needs a decision before anyone has data, not after.
- **App identity:** Android/iOS/desktop are still `buzz.armada.app`, signed and associated with
  Soapbox's team and `armada.buzz`. Shipping apps needs our own id, signing keys, and
  `assetlinks.json` / `apple-app-site-association` on our domain.
- **Links and services:** `armada.buzz` appears in share links, invite previews, the AV broker
  default, the push gateway and the release feed. Each needs a Wizardry home or a deliberate
  "we use the public one".
- **Component names** (`ArmadaCrest`, `ArmadaDB`, on-disk `concord2-*` keys) stay as they are, the
  way the repo's own notes say on-disk identifiers must: nobody sees them, and renaming loses data.
- **Licence:** it is AGPL-3.0. Keep upstream's notices, publish our source (the repo is public),
  and note that the App Store exception in the README is Soapbox's to grant, not ours.

## 4. The wizard sloth, and themes

- **One mascot sheet.** The mark exists; draw the same sloth for the empty states, the sign-up
  steps, the recovery-code screen (holding a key), errors, and the twelve-face emoji pack already
  made for the other Wizardry.
- **Default theme: "Grove".** The canopy greens and honey accent from `brand/theme.css` in the
  Wizardry repo, as the built-in dark theme, with a matching light one. Replace the `armada` preset.
- **A small themed set** in the presets: Grove, Moonlit (deep blue, silver), Lantern (warm amber),
  Spellbook (parchment light theme), Midnight Moss (OLED black). Each is three core colours; the
  rest derives, so they are cheap and stay consistent.
- **Sign-in page art.** The portrait forest backdrop and glass card from the other Wizardry, reused
  here so both feel like one place.
- **Sound and motion, lightly:** a soft chime set to replace the nautical ones, fireflies on the
  landing page only, everything off under reduced-motion.

## 5. Worth doing after

- **Passkeys** as a second way to unlock the vault on a device (WebAuthn PRF), so the password is
  typed once per device.
- **Two-step sign-in** (TOTP) for the account, since the mailbox is otherwise the weak point.
- **Sessions list** in Settings: where you are signed in, with "sign out everywhere".
- **Invite-only sign-up:** an invite code field the server checks, for a closed community.
- **Export:** one button that downloads the key and the recovery details as a file, for people who
  want to leave or keep a copy offline.
- **Abuse:** disposable-address blocking is deliberately *not* planned; it would mean keeping
  addresses. Rate limits and invite-only cover the same ground without that.
