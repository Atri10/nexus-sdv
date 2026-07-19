import type { NextConfig } from "next";

const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@google-cloud/bigtable', 'nats'],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
