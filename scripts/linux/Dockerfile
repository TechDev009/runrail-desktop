# Linux build and test image (scripts/linux.ts). Ubuntu 22.04 has the oldest glibc and WebKitGTK
# the Linux builds target, so what builds and passes here also runs on newer distributions.
FROM oven/bun:1.4.2 AS bun
FROM rust:1.99.0-bookworm AS rust

FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates clang cmake curl file git pkg-config unzip xz-utils \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev \
      xvfb xauth weston dbus dbus-x11 gnome-keyring libsecret-tools dunst xclip libasound2-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN git config --global user.email linux@example.invalid && git config --global user.name linux
# Browser preview e2e: real clicks and keys into the app under Xvfb.
RUN apt-get update && apt-get install -y --no-install-recommends xdotool && rm -rf /var/lib/apt/lists/*
# Computer use e2e: a window manager to raise and focus windows, and xev to see the input.
RUN apt-get update && apt-get install -y --no-install-recommends openbox x11-utils && rm -rf /var/lib/apt/lists/*
