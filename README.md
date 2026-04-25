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

## Configuration

Core API settings live in `config.toml`. The backend reads `PICTU_CONFIG` when
set, otherwise it falls back to `../config.toml` from the server directory or
`config.toml` from the repository root.

## Notes

- Uploaded files are proxied to Evolink's file API before being used as image
  references.
- Image generation is asynchronous. The backend creates an Evolink task and
  polls task status for the UI.
- Generated image URLs are stored in task records, but provider-hosted image
  URLs may expire. Production deployments should mirror final images to durable
  object storage.
