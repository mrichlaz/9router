# EasyPanel deployment

Run the fork on [EasyPanel](https://easypanel.io) using the prebuilt GHCR image.

This image is **zero-build**: it does not compile Next.js. It downloads the same
`9router-latest.tgz` that the README's "Opsi 1" installs via npm, so the
container runs **byte-identical application code** to a local
`npm install -g <tarball>`. The image builds in seconds instead of ~10 minutes
and needs no `python3`/`make`/`g++` toolchain.

---

## 1. Image

```text
ghcr.io/mrichlaz/9router:latest      # newest stable release
ghcr.io/mrichlaz/9router:0.5.99      # pinned version
```

Both are published by `.github/workflows/release.yml` on every `v*` tag.
`latest` moves only on stable tags; a prerelease tag such as `v0.6.0-rc.1`
publishes only its numbered image.

> **Package visibility.** GHCR packages start private. The release workflow
> tries to flip the package to public automatically, but that call can be
> rejected for a repo-scoped token. If EasyPanel reports a pull/authorization
> error, open **GitHub → your profile → Packages → 9router → Package settings →
> Change visibility → Public**. Alternatively keep it private and add a GHCR
> registry credential in EasyPanel (see step 3b).

---

## 2. Create the app

In EasyPanel: **Create → App**, then:

| Setting | Value |
| --- | --- |
| Name | `9router` |
| Source | **Docker Image** |
| Image | `ghcr.io/mrichlaz/9router:latest` |

Add a **port mapping**: container port `20128` (published or internal, your choice).

Add a **volume mount** so data survives redeploys:

| Mount path | Notes |
| --- | --- |
| `/app/data` | SQLite DB, certs, runtime configs |

---

## 3. Environment

### 3a. Required

| Variable | Value | Why |
| --- | --- | --- |
| `DATA_DIR` | `/app/data` | Makes the volume mount the data root. Without it the app writes to `~/.9router` inside the container and your data is lost on redeploy. |
| `PORT` | `20128` | Listen port. Match this to the container port in step 2. |
| `HOSTNAME` | `0.0.0.0` | Bind all interfaces so EasyPanel's proxy can reach the app. |

### 3b. Optional

| Variable | Purpose |
| --- | --- |
| `DEBUG` | `true` for verbose logs. |
| `HEADROOM_URL` | Point at a Headroom sidecar, e.g. `http://headroom:8787`. |
| `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` | Override the default `128mb` request body cap. |

Only if you kept the GHCR package private, add a **Registry** credential in
EasyPanel (Settings → Registries) with your GitHub username and a
`read:packages` personal access token.

---

## 4. Deploy

Hit **Deploy**. The container health check (`/api/health`) reports ready in a
few seconds. Open `http://<your-easypanel-host>:20128/dashboard`.

---

## 5. Updating

The image is immutable per version tag, so EasyPanel will not see new code until
the tag changes. Two options:

- **Follow releases:** keep the image at `ghcr.io/mrichlaz/9router:latest` and
  redeploy after a new release is published (EasyPanel → **Redeploy**, which
  re-pulls the tag).
- **Pin:** set the image to a numbered tag such as `ghcr.io/mrichlaz/9router:0.6.0`
  and bump it deliberately. Safer for production, since `latest` can move.

To roll back, set the image to the previous numbered tag and redeploy.

---

## Building the image locally

```bash
# Serve a locally packed tarball, then point the build at it.
npm run cli:pack
cp 9router-*.tgz 9router-latest.tgz
python3 -m http.server 8099 &

docker build -f Dockerfile.prebuilt \
  --build-arg APP_VERSION=0.5.99 \
  --build-arg TARBALL_URL=http://host.docker.internal:8099/9router-latest.tgz \
  -t 9router-prebuilt .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  9router-prebuilt
```

Pass `TARBALL_SHA256` to make the build verify the download.

---

## Why two Dockerfiles?

| File | Trigger | Behaviour |
| --- | --- | --- |
| `Dockerfile` | upstream `docker-publish.yml` (**manual only** on this fork) | From-source build: `npm install` + `next build` inside the image. Slow and needs a toolchain. |
| `Dockerfile.prebuilt` | `.github/workflows/release.yml` (automatic on `v*` tags) | Zero-build: downloads the release tarball. Fast, small, and identical to the npm install. |

The from-source workflow is manual-only here so it cannot race the release
workflow for the same GHCR tag.
