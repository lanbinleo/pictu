# PicTu

PicTu is a lightweight mobile-first AI image generation and editing workspace.
It uses a React frontend served by a Go/Gin backend, with TOML-based provider
configuration, multi-tenant users, and credit accounting.

## Quick Start

```powershell
Copy-Item config.example.toml config.toml
# edit config.toml and set your Evolink API key

cd web
npm install
npm run build

cd ..\server
go mod tidy
go run .\cmd\pictu
```

Open `http://localhost:8080`.

## Docker

Build and run locally:

```powershell
Copy-Item config.docker.example.toml config.docker.toml
# edit config.docker.toml and set jwt_secret plus provider API keys
docker compose up --build -d
```

The container reads `/data/config.toml`. With the included
`docker-compose.yml`, `config.docker.toml` is mounted there, and the SQLite
database plus generated files live in the `pictu-data` Docker volume.

For a server using the GitHub Container Registry image:

```bash
git clone git@github.com:lanbinleo/pictu.git
cd pictu
cp config.docker.example.toml config.docker.toml
# edit config.docker.toml
docker compose pull
docker compose up -d
```

The app is served on port `8080` by default. Override the host port with:

```bash
PICTU_PORT=3000 docker compose up -d
```

Health check endpoint:

```text
/api/healthz
```

## Image Publishing

`.github/workflows/docker-image.yml` builds the image on pushes to `master`,
`main`, version tags, and manual workflow runs. Pull requests build the image
without pushing it.

Published image tags include:

```text
ghcr.io/lanbinleo/pictu:latest
ghcr.io/lanbinleo/pictu:master
ghcr.io/lanbinleo/pictu:sha-<commit>
```

## Configuration

Core API settings live in `config.toml`. The backend reads `PICTU_CONFIG` when
set, otherwise it falls back to `../config.toml` from the server directory or
`config.toml` from the repository root.

For Docker, use `config.docker.example.toml` as the starting point because it
sets `frontend_dist = "/app/web/dist"` for the container filesystem.

## Notes

- Uploaded files are proxied to Evolink's file API before being used as image
  references.
- Image generation is asynchronous. The backend creates an Evolink task and
  polls task status for the UI.
- Generated image URLs are stored in task records, but provider-hosted image
  URLs may expire. Production deployments should mirror final images to durable
  object storage.
