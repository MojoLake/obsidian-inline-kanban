import { build } from "esbuild";
import { readFileSync } from "fs";

const isProd = process.argv.includes("production");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

await build({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  sourcemap: isProd ? false : "inline",
  minify: isProd,
  banner: {
    js: `/*
Inline Kanban v${manifest.version}
*/`,
  },
});
