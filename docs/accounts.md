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
| `session/status` | session | Whether a vault, a recovery copy and a linked key exist. |
| `session/salt`, `session/unlock` | session, authKey | Checks the password again and returns the vault, for one settings action. |
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

The client turns accounts on when its `ACCOUNT_SERVER` setting names the server's origin. That
origin must be `https://`: the page's Content-Security-Policy allows nothing else, and the screen
reports a plain-http server as unreachable.

## Deploying it

The files are in `deploy/account-server/`. On the machine that will run it (Node 22.13 or newer):

1. `npm run build:account-server`, then as root
   `deploy/account-server/install.sh server/account-server.mjs`. It makes the `wizardry-accounts`
   user, `/opt/wizardry-accounts`, the state directory, the systemd unit, and
   `/etc/wizardry-accounts/env` with a fresh pepper that is never printed.
2. Edit the `CHANGE` lines in `/etc/wizardry-accounts/env`: the public origin, the site's origin,
   and the From address. **Copy the pepper line somewhere other than where the database backups
   go.**
3. Point DNS for the hostname at the machine. Not through a proxying CDN: the server's rate limits
   count the address nginx sees.
4. Get a certificate, then install `nginx.conf` as a vhost (the steps are at the top of the file).
5. `systemctl enable --now wizardry-accounts`, then `curl https://<hostname>/healthz`.
6. Add `/opt/wizardry-accounts/backup.sh` to root's cron. It writes a consistent, checked copy of
   the database to `/var/backups/wizardry-accounts` and keeps fourteen; include that directory in
   the off-site backup.
7. Build the web client with `ACCOUNT_SERVER=https://<hostname>` and deploy it. Until then the app
   stays key-only, so the server can be up and tested first.

To update: build, run `install.sh` again. It keeps the settings file and restarts the service.

The From address must be one the mail server will sign (SPF and DKIM aligned), or the codes land
in spam.

## In the app

- **`LoginScreen`** shows the email-and-password step (`AccountGate`) first. An account that holds
  a key is opened and logged in there; one that holds none goes on to the usual key screen.
- **`AccountKeySync`** runs for anyone signed in. A fresh account's `nsec` is locked into the vault
  and its recovery code shown (the dialog will not close until the code is copied or downloaded);
  any kind of key is linked by a signed proof. Someone logged in with a key but no account is
  asked for one and can only log out instead. The last logout ends the server session.
- **Settings › Account** has an "Email account" group (`AccountServerSettings`): whether a key is
  stored, store it, make a new recovery code, change the password, remove the stored key, delete
  the email account. Each action asks for the password, which is checked by `session/unlock`
  (ten tries per ten minutes) and reopens the vault for that one action.
- **`session.ts`** keeps the token on disk and the unlocked vault key in memory only, so a reload
  mid-setup asks for the password again rather than storing the key unprotected.

## Status

Built and tested: the protocol, the client-side cryptography, the API client, the server rules, the
SQLite store, the mailer against a local SMTP server, and the screens above against the real server
rules. The whole sign-up was also run in a browser against the built server, ending with a
confirmed account, a stored vault and recovery copy, one key hash, and no address at rest.

Not built yet: everything under "The plan" from step 2 on.

# The plan

## 1. Accounts in the app

Done: the gate, sign-up with an emailed code, sign-in on a new device, the recovery-code screen,
forgotten password (with and without the recovery code), sign-out, and Settings › Account, in all
eight languages.

Also done: the copy that assumed there is no account (account standing, the support page, the
landing page) has an account version when `ACCOUNT_SERVER` is set, and a key locked into the vault
no longer counts as "only on this device" for the backup reminder and the logout warning. Removing
the stored key turns that reminder back on.

## 2. Deployment

- The files and steps are written ("Deploying it" above) and the backup script was run against a
  real database. Not yet done on the host: the install itself, DNS, the certificate, and a code
  arriving through the real mail server.
- Optional: a members-only relay that calls `member/check` on NIP-42 AUTH, so the email gate is
  real for the community's own rooms and not just a screen in one client.

## 3. Finishing the rebrand

The mark, the copy, the hosted site and the app identity say Wizardry. Still Armada underneath:

- **Done:** the app's default name, the copy in all eight languages, "Wizardry Ultra", and the
  link-preview cards (titles and the drawn wordmark).
- **Done, identity:** the apps are `xyz.slothlee.wizardry` on Android, iOS (App Group
  `group.xyz.slothlee.wizardry`), desktop and Flatpak; `APP_ID` is `wizardry`, so settings live
  under `wizardry/…` apart from upstream's; the desktop shell says Wizardry in its window, tray,
  dialogs and installer names. Upstream's release key is no longer trusted (`RELEASE_AUTHORS` is
  empty), so a desktop build never loads Armada's web app or installs Armada's updates; it runs the
  web app it shipped with. The Java/Kotlin package (`buzz.armada.app`) stays: it is the code's
  namespace, not the app's identity, and moving it would touch every native file for nothing.
- **Still to do for shipping apps:** our own Android signing key, an Apple team (`DEVELOPMENT_TEAM`
  is empty and `ios-release.sh` now requires `IOS_TEAM_ID` and the App Store Connect key), a
  release key for `RELEASE_AUTHORS` and `.ngit/release.yaml`'s `pubkey`, and a domain for app links
  (`assetlinks.json` and `apple-app-site-association` are empty until then).
- **Downloads:** `/downloads` and the no-JavaScript page offer Soapbox's packages, which install
  Armada, not Wizardry (no account step, their branding). Until we publish our own builds, either
  hide the page or say plainly that the apps are upstream's.
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
