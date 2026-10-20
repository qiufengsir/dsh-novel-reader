import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const source = path.dirname(fileURLToPath(import.meta.url));
const packageName = "dsh-zhijian-reader";
const legacyName = "dsh-novel-reader";
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
const backup = packagePath + ".before-zhijian-reader-" + Date.now() + ".bak";
if (fs.existsSync(packagePath)) fs.copyFileSync(packagePath, backup);
for (const target of [
  path.join(profile, "plugins", "dsh-zhijian-reader"),
  path.join(profile, "node_modules", "dsh-zhijian-reader"),
]) {
  fs.mkdirSync(target, { recursive: true });
  for (const item of ["package.json", "cordis.patch.yml", "lib", "locale", "icon.svg", "README.md", "LICENSE"])
    fs.cpSync(path.join(source, item), path.join(target, item), {
      recursive: true,
    });
}
manifest.dependencies = {
  ...manifest.dependencies,
  "dsh-zhijian-reader": "file:./plugins/dsh-zhijian-reader",
};
// Disable the legacy registration without deleting its files or the shared reading database.
delete manifest.dependencies[legacyName];
manifest.dsh ??= {};
manifest.dsh.profile ??= {
  bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
};
manifest.dsh.profile.bundles ??= [];
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(
  (name) => name !== legacyName && name !== packageName,
);
manifest.dsh.profile.bundles.push(packageName);
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
console.log("Installed and enabled dsh-zhijian-reader in " + profile);
console.log(
  "Restart DeepSeek Harness, then open a session and choose 纸间 · 小说阅读器 in the right sidebar.",
);
console.log(
  "Rollback: remove dsh-zhijian-reader from dsh.profile.bundles in package.json. Reading data is retained.",
);
