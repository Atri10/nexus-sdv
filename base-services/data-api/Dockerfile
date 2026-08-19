# Build context is the repo root (see local-dev/docker-compose.yml) so this
# Dockerfile can pull shared .proto definitions from the top-level proto/ dir.
ARG DOCKER_HUB_MIRROR=docker.io
FROM --platform=$BUILDPLATFORM ${DOCKER_HUB_MIRROR}/golang:1.25-alpine AS builder

WORKDIR /app

# Install protoc and protoc-gen-go(-grpc) for protobuf generation
RUN apk add --no-cache protobuf protobuf-dev && \
    go install google.golang.org/protobuf/cmd/protoc-gen-go@latest && \
    go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

COPY base-services/data-api/go.mod base-services/data-api/go.sum ./
RUN GOTOOLCHAIN=auto go mod download

COPY base-services/data-api/src ./src
COPY proto/data-api.proto api/data-api.proto

# Generate protobuf/gRPC stubs (not committed - regenerated on every build)
ENV PATH="/root/go/bin:${PATH}"
RUN mkdir -p api/gen/dataapi/v1 && \
    protoc --go_out=. --go_opt=module=data-api \
        --go-grpc_out=. --go-grpc_opt=module=data-api \
        api/data-api.proto

ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -o /server ./src

FROM ${DOCKER_HUB_MIRROR}/alpine:latest

COPY --from=builder /server /server
EXPOSE 8080

ENTRYPOINT [ "/server" ]
