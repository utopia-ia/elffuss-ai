# Publishing the tool sites

How to put `cutout`, `ocr`, `detect` and `depth` `.elffuss.com`, and the catalog
`tools.elffuss.com`, on the server. **Written, not run**: nothing in this
repository has been deployed, and none of these commands has been tried on the
server. `deploy/README.md` explains the pieces; this file is the exact order.

Placeholders: `<server>` is the machine that `*.elffuss.com` points to (the DNS
wildcard already sends the five names there), `<key>` the SSH key for it, and
`<repo>` a clean checkout of this repository at the commit to publish. The
model store's page lives in the broker repository (`elffuss-claw`, branch
`broker-put-offline`, commit `c08760a`, what the store serves today); its
`server/broker/README.md` names the three hosts that serve that page and their
docroots: they are `<store docroots>` and `<store URLs>` below (the second with
both domains). `<weights URL>` is a file of one of the model servers, as in the
checks of the CORS document of the engine repository.

Rules that hold for every step:

- On weekdays, nothing goes out from 08:00 to 15:59; weekends and holidays at
  any time. `deploy/lib/deploy-site.sh` refuses the window unless
  `--ignore-window` (or `ELFFUSS_HOLIDAY=1`).
- nginx is **reloaded, never restarted**, and only after `sudo nginx -t` passes.
- On that machine, no recursive searches or bulk copies: its disk is shared
  with the DNS. Each step below touches only the files it names.
- Steps 1 and 2 change what other Elffuss sites depend on (the model store and
  the CORS map of the model servers). Do them first and check them before any
  tool site goes up: without step 1 every tool page says `store-unavailable`.

## 0. Before anything

On a clean checkout of the commit to publish:

```bash
cd <repo>
/usr/bin/git status --porcelain                      # must print nothing
node --test "tests/unit/*.test.mjs"                  # all pass
node scripts/build-docs.mjs --check                  # docs match the code
node deploy/build-nginx.mjs --check                  # deploy/nginx matches deploy/headers.mjs
node scripts/build-registry.mjs --check              # network: the registry matches the Hub
node scripts/vendor.mjs --check                      # the runtimes match their pins
ELFFUSS_SWEEP_PRIVATE=<file of private terms> node scripts/sweep.mjs --release --git
node scripts/broker-repos.mjs                        # the lines the store needs (step 1)
```

On the server, read-only:

```bash
ssh -i <key> <server> 'sudo nginx -t && sudo nginx -T 2>/dev/null | grep -n "server_name" | grep -E "tools|cutout|ocr|detect|depth|elffuss.com"'
ssh -i <key> <server> 'sudo certbot certificates 2>/dev/null | grep -E "Certificate Name|Domains|Expiry"'
ssh -i <key> <server> 'ls -ld /var/www/letsencrypt <store docroots>'
```

The first must show no `server_name` for the five new hosts (a duplicate would
take the request). The second says how the existing certificates were issued:
if they use the webroot `/var/www/letsencrypt`, follow step 4 as written; if
not, issue the five the same way the others were.

## 1. The model store accepts the tool sites (broker patch, version 3)

The patch is `_propuestas/2026-10-25-elffuss-ai-broker-herramientas.patch`
(next to the repositories, not applied anywhere). It adds the five hosts with a
read-only permission: each tool may only `has`, `get` (with the exact size) and
`cancel` the 15 files that the variants of `registry/tasks.json` use, never
`clear`, `put` or `diag`, and nothing a tool asks deletes a stored copy. It was
tested in a copy of the broker repository at `c08760a`, not on the server.

In a worktree of the broker repository:

```bash
cd <elffuss-claw worktree on broker-put-offline at c08760a>
/usr/bin/git apply --check <patch>
/usr/bin/git apply --index <patch>
node tests/broker-herramientas.mjs      # 76/76, on both copies of the page
node tests/broker-origenes.mjs          # green
node tests/broker-integridad.mjs        # green
shasum -a 256 server/broker/index.html  # 4dc44b50ffac9e11a1b2279a73d8754b50efbdb098469b7417e9f12c2ca381a0
/usr/bin/git commit -m "Broker: read-only access for the elffuss-ai tool sites"
```

The block `FICHEROS_HERRAMIENTAS` in the patched page must be exactly what
`node scripts/broker-repos.mjs` prints in this repository at the commit being
published (a unit test here checks the copy in `tests/fixtures/broker/`).

Deploy it with the broker's own recipe (`server/broker/README.md`, «Cómo se
despliega»): to the THREE hosts of the store. `sw.js` does not change with this
patch (it serves the page network first, so the new page reaches browsers that
are online).

```bash
for d in <store docroots>; do
  ssh -i <key> <server> "sudo cp -p $d/index.html $d/index.html.bak-$(date +%Y%m%d)"
done
scp -i <key> server/broker/index.html <server>:/tmp/br.html
for d in <store docroots>; do ssh -i <key> <server> "sudo cp /tmp/br.html $d/index.html"; done
for u in <store URLs>; do curl -s "$u" | shasum -a 256; done     # 4dc44b50…381a0 every time
```

Check that Claw still loads its model from the store (its permission did not
change). Rollback: copy `index.html.bak-<date>` back over `index.html` in the
three docroots.

## 2. The CORS map of the model servers

The patch is `_propuestas/2026-10-25-elffuss-ai-pesos-cors.patch`: five lines
in `/etc/nginx/conf.d/elffuss-pesos-cors.conf`, after the lines of the store's
own hosts (the patch shows the place). The tools never read from the model
servers directly (their CSP only allows their own origin); the lines keep the
map equal to the broker's list, as the CORS document of the engine asks. The
patch applies to the text of that document; the live file was not read.

```bash
ssh -i <key> <server> 'sudo cp -p /etc/nginx/conf.d/elffuss-pesos-cors.conf /etc/nginx/conf.d/elffuss-pesos-cors.conf.bak-$(date +%Y%m%d)'
ssh -i <key> <server> 'sudo cat /etc/nginx/conf.d/elffuss-pesos-cors.conf'   # compare with the patch's context first
# If it matches, apply the patch there; if not, insert the five lines by hand where the patch puts them.
ssh -i <key> <server> 'sudo nginx -t && sudo systemctl reload nginx'
curl -s -o /dev/null -D - -r 0-0 -H "Origin: https://ocr.elffuss.com" <weights URL> | grep -i -E "access-control-allow-origin|vary"
curl -s -o /dev/null -D - -r 0-0 -H "Origin: https://ocr.elffuss.utopiaia.com" <weights URL> | grep -ci access-control-allow-origin   # 0
```

The first `curl` must show `access-control-allow-origin: https://ocr.elffuss.com`
and `Vary: Origin`; the second, no such header. Rollback: the `.bak-<date>` copy,
`nginx -t`, reload.

## 3. nginx for the five hosts, port 80 only

The files are generated in `deploy/nginx/` (`node deploy/build-nginx.mjs`
writes them; `--check` compares). First the common parts and the port-80
blocks: the 443 blocks name certificates that do not exist yet, and `nginx -t`
would fail on them.

```bash
cd <repo>
scp -i <key> deploy/nginx/conf.d/elffuss-ai.conf <server>:/tmp/
scp -i <key> deploy/nginx/snippets/elffuss-ai-*.conf <server>:/tmp/
for h in tools cutout ocr detect depth; do scp -i <key> deploy/nginx/sites-available/$h.elffuss.com.80.conf <server>:/tmp/; done
ssh -i <key> <server> 'sudo install -m 644 /tmp/elffuss-ai.conf /etc/nginx/conf.d/elffuss-ai.conf &&
  sudo install -m 644 /tmp/elffuss-ai-*-headers.conf /etc/nginx/snippets/ &&
  for h in tools cutout ocr detect depth; do
    sudo install -m 644 /tmp/$h.elffuss.com.80.conf /etc/nginx/sites-available/$h.elffuss.com.conf &&
    sudo ln -sf /etc/nginx/sites-available/$h.elffuss.com.conf /etc/nginx/sites-enabled/$h.elffuss.com.conf &&
    sudo mkdir -p /var/www/$h.elffuss.com/site; done &&
  sudo nginx -t && sudo systemctl reload nginx'
for h in tools cutout ocr detect depth; do curl -s -o /dev/null -w "$h %{http_code} %{redirect_url}\n" http://$h.elffuss.com/; done   # 301 to https://<host>/
```

Never leave a `.bak` file in `sites-enabled/`: nginx loads every file there.

## 4. One certificate per host (HTTP-01, the existing webroot)

One certificate per host, so that a failed renewal of one does not take the
others down:

```bash
for h in tools cutout ocr detect depth; do
  ssh -i <key> <server> "sudo certbot certonly --webroot -w /var/www/letsencrypt -d $h.elffuss.com --non-interactive --agree-tos --keep-until-expiring"
done
ssh -i <key> <server> 'sudo certbot renew --dry-run'
```

## 5. nginx, port 443

Replace each port-80 file with the full vhost. Before copying, put into its 443
block the same TLS include the other vhosts of the server use (the generated
file has a comment where it goes; which include it is was not verified here).

```bash
for h in tools cutout ocr detect depth; do scp -i <key> deploy/nginx/sites-available/$h.elffuss.com.conf <server>:/tmp/$h.full.conf; done
ssh -i <key> <server> 'for h in tools cutout ocr detect depth; do sudo install -m 644 /tmp/$h.full.conf /etc/nginx/sites-available/$h.elffuss.com.conf; done && sudo nginx -t && sudo systemctl reload nginx'
```

## 6. The sites, PRE first

Each site is copied on its own, from a build of the commit (never the working
tree), with `deploy/deploy-<site>.sh`. It runs the unit tests and the sweep on
the build, uploads the new `v/<build>/`, adds to `vendor/`, swaps the pages in
with `mv -f`, prunes old builds, and checks by `curl` that what is served is the
build. Nothing is synced with `--delete`.

```bash
cd <repo>
export ELFFUSS_HOST=<user@server> ELFFUSS_KEY=<key> ELFFUSS_SWEEP_PRIVATE=<file of private terms>
for s in tools cutout ocr detect depth; do deploy/deploy-$s.sh --channel pre --dry-run; done
for s in tools cutout ocr detect depth; do deploy/deploy-$s.sh --channel pre; done
```

PRE lives at `https://<host>/beta/` (not indexed). Check it in a browser with a
fresh profile (section 7), then PRO:

```bash
for s in tools cutout ocr detect depth; do deploy/deploy-$s.sh; done
```

## 7. Health checks

For each host, from outside:

```bash
for h in tools cutout ocr detect depth; do
  curl -fsS -o /dev/null -w "$h %{http_code}\n" https://$h.elffuss.com/
  curl -fsS -D - -o /dev/null https://$h.elffuss.com/ | grep -i -E "^content-security-policy|^permissions-policy|^strict-transport|^cross-origin-opener"
  curl -fsS https://$h.elffuss.com/ | grep -c 'href="https://tools.elffuss.com/"'
  echo | openssl s_client -connect $h.elffuss.com:443 -servername $h.elffuss.com 2>/dev/null | openssl x509 -noout -subject -enddate
done
curl -fsS -D - -o /dev/null https://ocr.elffuss.com/vendor/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.asyncify.wasm | grep -i -E "content-type|cache-control"   # application/wasm, immutable
curl -fsS -D - -o /dev/null https://detect.elffuss.com/ | grep -i permissions-policy     # camera=(self) only here
```

In a browser, with a fresh profile, for each tool page:

1. it loads in Spanish (`/`) and English (`/en/`) with no error and no CSP
   violation in the console;
2. the primary button says it will download the model, with its size;
3. after a run, the result is right (a photo of text reads, a photo gets its
   background removed, objects are boxed, a depth map appears);
4. on reload, the Network panel shows no request to Hugging Face (the model
   comes from the store), and the button no longer says it will download;
5. the catalog `https://tools.elffuss.com/` lists the four tools with their
   links, and marks «Ya está en este navegador» on the one just used.

The weights never pass through this server: count Hugging Face requests in the
browser, not in the nginx logs. Watchdog: one HTTP check per host (status 200,
a content mark such as the catalog link, the CSP header) and the certificate
expiry of each; alerts only, no restarts for a static site.

## 8. Rollback

- **A site:** every build stays in `v/<build>/` until it is pruned (the three
  newest are kept), and only the pages point at a build. Deploy the previous
  commit of this repository (`/usr/bin/git checkout <commit>` and
  `deploy/deploy-<site>.sh --ignore-window`), or put back the previous pages.
- **All five at once:** remove the five links in `/etc/nginx/sites-enabled/`
  (`elffuss-ai.conf` in `conf.d` can stay: it only defines a log format and a
  connection zone), `nginx -t`, reload. The certificates and docroots can stay.
- **The store (step 1):** the `index.html.bak-<date>` copies in the three
  docroots. The tools then say `store-unavailable`; the other sites are as
  before.
- **The CORS map (step 2):** its `.bak-<date>`, `nginx -t`, reload.
