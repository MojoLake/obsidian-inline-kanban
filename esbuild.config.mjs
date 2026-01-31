import { spawn } from "child_process";
import { build, context } from "esbuild";
import { readFileSync } from "fs";

const isProd = process.argv.includes("production");
const isWatch = process.argv.includes("watch");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

let deployQueue = Promise.resolve();
const queueDeploy = () => {
  if (!isWatch) return;
  deployQueue = deployQueue.then(
    () =>
      new Promise((resolve) => {
        const child = spawn("node", ["scripts/deploy.mjs"], {
          stdio: "inherit",
        });
        child.on("close", () => resolve());
        child.on("error", (error) => {
          console.error("Auto-deploy failed", error);
          resolve();
        });
      }),
  );
};

const buildOptions = {
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
  plugins: isWatch
    ? [
        {
          name: "auto-deploy",
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length > 0) {
                console.error("Rebuild failed", result.errors);
                return;
              }
              queueDeploy();
            });
          },
        },
      ]
    : [],
};

if (isWatch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
} else {
  await build(buildOptions);
}
