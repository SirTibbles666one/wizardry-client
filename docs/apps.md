# The Wizardry apps

Where the phone and desktop apps stand as Wizardry's own, and what to do to build them. Nothing
here publishes to a store: every step ends with a file on your machine.

## Identity

| | Wizardry | Was (upstream Armada) |
|---|---|---|
| Android application id | `xyz.slothlee.wizardry` | `buzz.armada.app` |
| Android app name | Wizardry | Armada |
| Signing key | yours, made by `scripts/android-signing.sh` | Soapbox's |
| Links that open in the app | your site, once set (below) | `armada.buzz` |

The application id is what a phone and a store know the app by. **It can be changed freely until
the first release is published or handed to anyone; after that, changing it makes a different app**
and nobody's install updates. If `xyz.slothlee.wizardry` is not the name you want, say so before
then.

Only the application id changed. The code's package is still `buzz.armada.app` (the `namespace` in
`android/app/build.gradle`, the Java/Kotlin folders, internal action names). That is deliberate:
it is invisible to users, and renaming a hundred files would make every future merge from Armada
conflict.

With its own id, Wizardry installs beside Armada instead of over it, and the two share no data.

## Android: your signing key

Android accepts an update only if it is signed by the same key as the installed app. The key is
yours alone: there is no copy anywhere else, and no way to replace it.

```sh
scripts/android-signing.sh init
```

It asks for a password (not shown, never printed), makes the key at
`~/.wizardry/android-release.jks`, and writes `android/key.properties`, which the release build
reads. Git ignores both. **Back up both files off the computer**, and keep the password in your
password manager.

`scripts/android-signing.sh fingerprint` prints the certificate's SHA-256. That value is public;
it is what a store or a website lists to say "this key is Wizardry's".

## Android: building

Needs a JDK 21 and the Android SDK (Android Studio installs both).

```sh
npm ci
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease
```

The signed app is `android/app/build/outputs/apk/release/app-release.apk`. Copy it to a phone and
open it to install ("install unknown apps" must be allowed for the file manager). Without
`key.properties` the same command produces an unsigned file that will not install.

For day-to-day work, `./gradlew installDebug -ParmadaDev=true` installs a debug copy as
`xyz.slothlee.wizardry.dev`, beside the real one.

To require accounts in the app, build the web part with `ACCOUNT_SERVER=https://<account host>`
and add `https://localhost` to the server's `ACCOUNT_ALLOWED_ORIGINS` (that is the origin the
Android app's pages load from).

## Android: links that open in the app

Optional. To make invite links on your site open in the app:

1. Set `wizardryWebHost=<your site's host>` in `android/gradle.properties`.
2. `scripts/android-signing.sh assetlinks` writes `public/.well-known/assetlinks.json` with the app
   id and your key's fingerprint. Commit it and deploy the site.

Until both are done the app claims no links, and the site vouches for no app (the file is an empty
list; it used to name Armada's app and Soapbox's key).

## Store accounts, for later

Nothing needs these until you publish, and nothing in the repository uses them yet.

- **Google Play:** a developer account (one-time fee, identity check). New personal accounts must
  run a closed test before production. Play re-signs with its own key; yours becomes the "upload
  key", and the fingerprint for `assetlinks.json` is then Play's, not yours.
- **Apple:** the Apple Developer Program (yearly fee) is needed even to keep a build on your own
  iPhone for more than a week, so iOS waits for that account. See below.
- **Without a store:** the signed APK can be shared directly, or through Zapstore or an F-Droid
  repository, both of which the upstream scripts already know how to feed.

## Desktop

The desktop app (`electron/`) is Wizardry too: product name, window, tray and update messages,
the Linux desktop entry, and the id `xyz.slothlee.wizardry` on Linux and Windows. It keeps its
data in its own folder, apart from an installed Armada.

```sh
cd electron && npm ci
npm run dist:linux     # AppImage and .deb, in electron/release/
npm run dist:win       # Windows installer (needs wine on Linux)
```

Unsigned builds run, with a warning: Windows SmartScreen says "unknown publisher", and macOS
refuses to open the app without a right-click. Removing those warnings needs a Windows
code-signing certificate and an Apple Developer ID, both paid and both later.

Still upstream's inside, on purpose: the `app://armada` origin, internal message names and the
screen-share helper's file name. Nobody sees them, and renaming them only makes merges harder.

## Updates and the downloads page

Upstream's apps update themselves, and its `/downloads` page lists builds, from releases signed
by Armada's key. A Wizardry build that trusted that key would replace itself with Armada. So the
default is now **no trusted signer**: nothing self-updates, `/downloads` redirects home, and the
landing page and Settings › About no longer link to Armada's store listings.

To turn it back on with your own builds: make a Nostr key used only for releases, publish
releases with it (`docs/releases.md`), and build with `RELEASE_AUTHORS=<that key's hex pubkey>`.

## Not done yet

- **Flatpak** files (`electron/flatpak/`) still carry Armada's id and name.
- **macOS and Windows signing**, as above.
- The package maintainer is written as `Wizardry <SirTibbles666one@users.noreply.github.com>`
  (GitHub's no-reply form). Change it in `electron/package.json` and `electron-builder.yml` if you
  want a contact address there.
- The spell-check dictionaries are still fetched from `armada.buzz`.
- **iOS** still carries Soapbox's team id and bundle id (`ios/`, and
  `public/.well-known/apple-app-site-association`). It cannot be signed without your Apple team,
  so it changes when that account exists.
- Neither the Android nor the desktop build has been run since these changes: the machine that
  made them has no Android SDK and did not package Electron. The first build on yours is the test.
