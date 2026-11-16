# Where Wizardry lives

| What | Where | Who runs it |
|---|---|---|
| Web app | `https://wizardry.slothlee.xyz` (`PUBLIC_WEB_ORIGIN`) | us, on the Hetzner server, behind Cloudflare |
| Email accounts | `ACCOUNT_SERVER` (see `docs/accounts.md`) | us, same server, **not** proxied by Cloudflare |
| Support, abuse and security mail | `support@slothlee.xyz` (`SUPPORT_EMAIL`, `security.txt`) | us |
| Concord voice tokens | `https://av.armada.buzz` (`CONCORD_AV_SERVERS`) | Soapbox, public and content-blind |
| Web and iOS push | the public nostr-push2 gateway (`NOSTR_PUSH2_*`) | its operator; sees encrypted events only |
| Default relays, Blossom, link previews | `relay.ditto.pub`, `blossom.ditto.pub`, `ditto.pub` and others | Soapbox and independent operators |
| Desktop spell-check dictionaries | `https://armada.buzz/dictionaries/` | Soapbox |

Share and invite links from the apps are built on `PUBLIC_WEB_ORIGIN`, and only links on that
origin open inside the app when clicked. An `armada.buzz` link opens Armada's site in the browser.

The voice broker and push gateway are kept on the public services on purpose; the privacy policy
says so. Each is a build setting, so moving to our own later is a rebuild, not a code change.

## Publishing the web app

On the server, once:

1. Point `wizardry.slothlee.xyz` at the server in Cloudflare. Proxied is fine for the web app; set
   SSL/TLS to **Full (strict)**.
2. `mkdir -p /var/www/wizardry`, get a certificate
   (`certbot certonly --nginx -d wizardry.slothlee.xyz`), and install `deploy/web/nginx.conf` as a
   vhost. `nginx -t`, then reload.

From a checkout, each time:

```sh
ACCOUNT_SERVER=https://<accounts host> deploy/web/publish.sh root@<server>
```

It builds with `PUBLIC_WEB_ORIGIN=https://wizardry.slothlee.xyz` and copies `dist/` across. Old
`/assets/` files are kept so a tab open on the previous build can finish loading.

Check afterwards: the site loads, a deep link such as `/settings` loads (not a 404), and
`curl -sI https://wizardry.slothlee.xyz/.well-known/apple-app-site-association` says
`content-type: application/json` with no redirect.

## Still Soapbox's

- **The nsite.** `.nsite/config.json` still publishes the build as a Nostr site named `wizardry`
  through Soapbox's CI workflow files. Those workflows run on Soapbox's infrastructure; the plain
  files above are what we serve.
- **The legal pages** describe the services above. Read them again whenever one of the rows
  changes.
