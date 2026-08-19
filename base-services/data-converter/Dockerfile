# Build context is the repo root (see local-dev/docker-compose.yml) so this
# Dockerfile can pull shared .proto definitions from the top-level proto/ dir.
ARG DOCKER_HUB_MIRROR=docker.io
FROM --platform=$BUILDPLATFORM ${DOCKER_HUB_MIRROR}/golang:1.25-alpine AS builder

WORKDIR /app

# Install protoc and protoc-gen-go for protobuf generation
RUN apk add --no-cache protobuf protobuf-dev && \
    go install google.golang.org/protobuf/cmd/protoc-gen-go@latest && \
    go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

COPY base-services/data-converter/go.mod base-services/data-converter/go.sum ./
RUN go mod download

COPY proto/telemetry.proto api/telemetry.proto
COPY base-services/data-converter/src ./src

# Generate protobuf files
ENV PATH="/root/go/bin:${PATH}"
RUN mkdir -p api/gen/telemetry && \
    protoc --go_out=api/gen/telemetry --go_opt=paths=source_relative \
        -I api \
        api/telemetry.proto

ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -o /data-converter ./src

FROM ${DOCKER_HUB_MIRROR}/alpine:latest

RUN addgroup -S app && adduser -S app -G app
USER app

COPY --from=builder /data-converter /data-converter

ENTRYPOINT ["/data-converter"]
