# Deploying the tool sites

Nothing here has been run against a server. This is the order to follow when the
sites go out; every step that touches the server is done by hand, by the owner.

## What exists

| Path | What it is |
|---|---|
| `headers.mjs` | The single source of every header and Content Security Policy |
| `sites.mjs` | The site list, read from `apps/*/app.json` and `catalog/app.json` |
| `build-nginx.mjs` | Writes `nginx/` from the two above (`--check` compares, `--nginx-test` runs `nginx -t` locally) |
| `nginx/conf.d/elffuss-ai.conf` | http-level: the connection limit zone and the log format with `$host` |
| `nginx/snippets/elffuss-ai-common-headers.conf` | Headers every location of every site carries |
| `nginx/snippets/elffuss-ai-<site>-headers.conf` | The common snippet, plus the site's CSP and Permissions-Policy |
| `nginx/sites-available/<host>.conf` | The vhost: port 80 (ACME and redirect) and 443 |
| `nginx/sites-available/<host>.80.conf` | Port 80 only, for the first certificate |
| `deploy-<site>.sh` | Deploy one site (calls `lib/deploy-site.sh`) |

Each site has its own docroot (`/var/www/<host>/site/`), vhost, certificate, log
and CSP. They share no files on the server: the SDK and the runtimes are copied
into each build.

## Order on the server

1. **The model store first.** The broker page of `models.elffuss.com` (and its
   copies) must accept the five tool origins with the read-only permission, or
   every site stays in `store-unavailable`. The change is proposed as a patch
   next to this repo, with its tests; it is applied and deployed in the store's
   own repository.
2. **The CORS map of the model servers**, for the two lists to stay equal
   (the tools never read from those servers directly). Also proposed as a patch.
3. **nginx, port 80 first.** Copy `conf.d/elffuss-ai.conf`, the snippets and the
   five `<host>.80.conf` files; enable them. Before reloading: `sudo nginx -t`
   and `sudo nginx -T | grep server_name`, to see duplicate names. Reload, never
   restart: `sudo systemctl reload nginx`.
4. **Certificates**, one per host, so a failed renewal of one does not take the
   others with it. Check first how the existing certificates were made
   (`sudo certbot certificates`) and do the same; with HTTP-01 and the port-80
   block above:
   `sudo certbot certonly --webroot -w /var/www/letsencrypt -d <host>`, five times.
   Then `sudo certbot renew --dry-run`.
5. **The 443 vhosts.** Replace each `<host>.80.conf` with `<host>.conf`. Copy into
   the 443 block the TLS options include the existing vhosts use (not verified
   here). `sudo nginx -t`, reload.
6. **PRE:** `deploy/deploy-<site>.sh --channel pre` puts the pages under `/beta/`
   (not indexed). Check each site there: it loads without errors, the model
   comes through the store, and a reload downloads nothing from Hugging Face,
   counted in the browser (the weights never pass through this server).
7. **PRO:** `deploy/deploy-<site>.sh`.
8. Watchdog (HTTP 200 with a content mark, the CSP present, certificate expiry;
   alerts only) and metrics (one entry per host, from its own log).

On weekdays nothing goes out from 08:00 to 15:59; the script refuses unless
`--ignore-window`, and `ELFFUSS_HOLIDAY=1` marks a holiday. The server and key
come from `ELFFUSS_HOST` and `ELFFUSS_KEY`, never from the repo. On that machine
no heavy searches or copies: the deploy only moves the files of one build.

## What a deploy does

`deploy/lib/deploy-site.sh <site>` builds from `git archive HEAD` (it refuses a
dirty tree), runs the unit tests and the publication sweep over the build, then
uploads `v/<build>/` (immutable, new each time), adds to `vendor/` (runtimes,
by version), and moves the pages into place one by one with `mv -f`. Nothing is
synced with `--delete`, so `/beta/` survives a PRO deploy and the other way
round. It keeps the three newest builds and the runtime versions they use, and
checks by `curl` that what is served has the sha256 of the build.

## Rolling back

Every build stays in `v/<build>/` until it is pruned, and the pages are the only
thing that points at a build. To go back, deploy the previous commit
(`git checkout <commit> && deploy/deploy-<site>.sh --ignore-window`), or, faster,
put back the previous pages: they are small, and their `v/<build>/` is still there.
