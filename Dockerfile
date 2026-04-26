# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:22-alpine AS web-builder
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS server-builder
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags="-s -w" -o /out/pictu ./cmd/pictu

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata wget \
    && addgroup -S pictu \
    && adduser -S -G pictu pictu \
    && mkdir -p /app/web/dist /data/generated \
    && chown -R pictu:pictu /app /data

WORKDIR /app
COPY --from=server-builder /out/pictu /app/pictu
COPY --from=web-builder /src/web/dist /app/web/dist
COPY config.docker.example.toml /app/config.example.toml

ENV GIN_MODE=release
ENV PICTU_CONFIG=/data/config.toml
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/api/healthz >/dev/null || exit 1

USER pictu
CMD ["/app/pictu"]
