ARG DOCKER_HUB_MIRROR=docker.io
FROM --platform=$BUILDPLATFORM ${DOCKER_HUB_MIRROR}/golang:1.25-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN GOTOOLCHAIN=auto go mod download

COPY src ./src
COPY api ./api

ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -o /server ./src

FROM ${DOCKER_HUB_MIRROR}/alpine:latest

COPY --from=builder /server /server
EXPOSE 8080

ENTRYPOINT [ "/server" ]