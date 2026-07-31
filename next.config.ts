import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray package-lock.json further up the tree makes Turbopack infer the
  // wrong workspace root, which breaks file tracing into the standalone build.
  // process.cwd() is where next is invoked from, i.e. the project root. Do NOT
  // compute this from import.meta.url — this package is not "type": "module",
  // so the config loads as CJS and that resolves to the wrong path.
  turbopack: {
    root: process.cwd(),
  },
  // Emits a self-contained server bundle in .next/standalone, so the droplet
  // only needs Node — no npm install of the full dependency tree on the box.
  output: "standalone",
};

export default nextConfig;
