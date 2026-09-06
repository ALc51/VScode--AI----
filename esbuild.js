const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const ctx = esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "dist/extension.js",
  external: ["vscode"],
});

if (watch) {
  ctx.then((ctx) => ctx.watch());
} else {
  ctx.then((ctx) => ctx.rebuild().then(() => ctx.dispose()));
}
