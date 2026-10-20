import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(manifest.name, "dsh-zhijian-reader");
assert.equal(manifest.license, "MIT");
assert.equal(manifest.engines.dsh, "0.2.1-rc.2");
assert.equal(manifest.peerDependencies["@deepseek-ai/cordis"], manifest.devDependencies["@deepseek-ai/cordis"]);
assert.equal(manifest.devDependencies["@deepseek-ai/dsh-client-ui-sidebar-right"], "0.2.1-rc.2");
assert.equal(manifest.type, "module");
assert.equal(manifest.exports["."], "./lib/index.js");
assert.equal(manifest.exports["./client"], "./lib/client.js");
assert.equal(manifest.exports["./package.json"], "./package.json");
assert.equal(manifest.dsh.client.platform, "web");
assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-sidebar-right"));
for (const relative of manifest.dsh.bundle.patch) {
  const patch = fs.readFileSync(path.resolve(root, relative), "utf8");
  assert.match(patch, /- insert:/);
  assert.match(patch, /name: dsh-zhijian-reader/);
}
for (const filename of ["lib/index.js", "lib/client.js", "icon.svg", "LICENSE", "README.md"]) {
  assert.ok(fs.statSync(path.join(root, filename)).size > 0, "Missing " + filename);
  assert.ok(manifest.files.includes(filename), "Not shipped: " + filename);
}
assert.equal(manifest.exports["./locale/*.json"], "./locale/*.json");
assert.ok(manifest.files.includes("locale/*.json"));
for (const locale of ["en", "zh"]) {
  const { meta } = JSON.parse(fs.readFileSync(path.join(root, "locale", locale + ".json"), "utf8"));
  assert.ok(meta.title.trim() && meta.description.trim());
}
assert.ok(fs.statSync(path.join(root, manifest.icon)).size < 256 * 1024);
const client = fs.readFileSync(path.join(root, "lib/client.js"), "utf8");
assert.ok(client.startsWith("window.__ModuleLoader__.load("));
assert.ok(client.includes('"dsh-zhijian-reader"'));
assert.ok(!manifest.scripts.install && !manifest.scripts.postinstall, "No install-time execution required");
console.log("Plugin manifest, exports, bundle, client, locales and distributable files verified.");
