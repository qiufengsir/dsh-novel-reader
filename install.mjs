import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const source = path.dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf("--profile");
const profile = path.resolve(
  at >= 0
    ? process.argv[at + 1]
    : path.join(
        process.env.DSH_HOME || path.join(os.homedir(), ".dsh"),
        "profiles",
        "desktop",
      ),
);
if (fs.existsSync(path.join(profile, "lock")))
  throw Error("Profile is locked. Close DeepSeek Harness before installation.");
const packagePath = path.join(profile, "package.json");
const manifest = fs.existsSync(packagePath)
  ? JSON.parse(fs.readFileSync(packagePath, "utf8").replace(/^\uFEFF/, ""))
  : {
      name: "dsh-profile-desktop",
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
        },
      },
    };
if (
  manifest.dsh?.profile?.bundles &&
  !Array.isArray(manifest.dsh.profile.bundles)
)
  throw Error("Unsupported profile bundles format");
fs.mkdirSync(profile, { recursive: true });
const backup = packagePath + ".before-novel-reader-" + Date.now() + ".bak";
if (fs.existsSync(packagePath)) fs.copyFileSync(packagePath, backup);
for (const target of [
  path.join(profile, "plugins", "dsh-novel-reader"),
  path.join(profile, "node_modules", "dsh-novel-reader"),
]) {
  fs.mkdirSync(target, { recursive: true });
  for (const item of ["package.json", "cordis.patch.yml", "lib"])
    fs.cpSync(path.join(source, item), path.join(target, item), {
      recursive: true,
    });
}
manifest.dependencies = {
  ...manifest.dependencies,
  "dsh-novel-reader": "file:./plugins/dsh-novel-reader",
};
manifest.dsh ??= {};
manifest.dsh.profile ??= {
  bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
};
manifest.dsh.profile.bundles ??= [];
if (!manifest.dsh.profile.bundles.includes("dsh-novel-reader"))
  manifest.dsh.profile.bundles.push("dsh-novel-reader");
fs.writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + "\n");
for (const [file, content] of [
  ["cordis.patch.yml", "# Profile overrides\n[]\n"],
  [
    "pnpm-workspace.yaml",
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
  ],
])
  if (!fs.existsSync(path.join(profile, file)))
    fs.writeFileSync(path.join(profile, file), content);
console.log("Installed and enabled dsh-novel-reader in " + profile);
console.log(
  "Restart DeepSeek Harness, then open a session and choose 小说阅读器 in the right sidebar.",
);
console.log(
  "Rollback: remove dsh-novel-reader from dsh.profile.bundles in package.json. Reading data is retained.",
);
