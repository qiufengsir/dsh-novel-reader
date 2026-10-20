const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
test("client module registers and disposes the expected sidebar slot", () => {
  let plugin,
    definition,
    registration,
    removed = false;
  const browser = {};
  browser.window = browser;
  browser.globalThis = browser;
  browser.__ModuleLoader__ = {
    load(m) {
      assert.equal(m.id, "dsh-zhijian-reader");
      plugin = m.factory(() => ({}));
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../lib/client.js"), "utf8"),
    browser,
  );
  assert.deepEqual(Array.from(plugin.inject), ["slots", "sidebarRightTabs"]);
  browser.document = {
    createElement: () => ({
      remove() {
        removed = true;
      },
    }),
    head: { append() {} },
  };
  const disposers = [];
  plugin.apply({
    effect(fn) {
      disposers.push(fn());
    },
    sidebarRightTabs: {
      register(d) {
        definition = d;
        return () => {};
      },
    },
    slots: {
      inject(name, fn) {
        assert.equal(name, "sidebar.right.pane.tab");
        return fn();
      },
      register(d, component) {
        registration = d;
        assert.equal(typeof component, "function");
        return () => {};
      },
    },
  });
  assert.equal(definition.kind, "dsh-zhijian-reader");
  assert.equal(definition.title(), "纸间 · 小说阅读器");
  assert.equal(registration.key, definition.id);
  assert.equal(definition.guide[0].title(), "纸间 · 小说阅读器");
  disposers.reverse().forEach((fn) => fn?.());
  assert.equal(removed, true);
});
test("installer preserves existing profile and is idempotent", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "novel-reader-check-"),
  );
  try {
    const p = path.join(directory, "package.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        name: "test",
        private: true,
        dependencies: { existing: "1.0.0" },
        dsh: { profile: { bundles: ["existing"] } },
      }),
    );
    fs.writeFileSync(
      path.join(directory, "cordis.patch.yml"),
      "# preserve me\n[]",
    );
    const run = () =>
      cp.execFileSync(
        process.execPath,
        [path.join(__dirname, "../install.mjs"), "--profile", directory],
        { stdio: "pipe" },
      );
    run();
    run();
    const m = JSON.parse(fs.readFileSync(p));
    assert.deepEqual(m.dsh.profile.bundles, ["existing", "dsh-zhijian-reader"]);
    assert.equal(m.dependencies.existing, "1.0.0");
    assert.equal(
      fs.readFileSync(path.join(directory, "cordis.patch.yml"), "utf8"),
      "# preserve me\n[]",
    );
    assert.ok(
      fs.existsSync(
        path.join(directory, "node_modules/dsh-zhijian-reader/lib/client.js"),
      ),
    );
    for (const target of ["plugins", "node_modules"]) {
      for (const file of ["locale/zh.json", "locale/en.json", "icon.svg", "README.md", "LICENSE"]) {
        assert.ok(fs.existsSync(path.join(directory, target, "dsh-zhijian-reader", file)), "Missing installed " + file);
      }
    }
    fs.writeFileSync(path.join(directory, "lock"), "1");
    assert.throws(run);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("renaming migrates legacy registrations once and retains legacy files and profile overrides", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zhijian-migration-"));
  try {
    const packagePath = path.join(directory, "package.json");
    const oldManifest = {
      name: "test",
      private: true,
      dependencies: { existing: "1.0.0", "dsh-novel-reader": "file:./plugins/dsh-novel-reader" },
      dsh: { profile: { bundles: ["existing", "dsh-novel-reader", "dsh-zhijian-reader", "dsh-novel-reader"] } },
    };
    fs.writeFileSync(packagePath, JSON.stringify(oldManifest));
    const oldFiles = [];
    for (const location of ["plugins", "node_modules"]) {
      const oldFile = path.join(directory, location, "dsh-novel-reader", "keep.txt");
      fs.mkdirSync(path.dirname(oldFile), { recursive: true });
      fs.writeFileSync(oldFile, "legacy rollback contents");
      oldFiles.push(oldFile);
    }
    const patchPath = path.join(directory, "cordis.patch.yml");
    fs.writeFileSync(patchPath, "# User overrides\n- id: user-setting\n  config: { enabled: true }\n");
    const run = () => cp.execFileSync(process.execPath, [path.join(__dirname, "../install.mjs"), "--profile", directory]);
    run();
    run();
    const installed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    assert.deepEqual(installed.dsh.profile.bundles, ["existing", "dsh-zhijian-reader"]);
    assert.equal(installed.dependencies["dsh-novel-reader"], undefined);
    assert.equal(installed.dependencies["dsh-zhijian-reader"], "file:./plugins/dsh-zhijian-reader");
    assert.equal(installed.dependencies.existing, "1.0.0");
    for (const file of oldFiles) assert.equal(fs.readFileSync(file, "utf8"), "legacy rollback contents");
    assert.match(fs.readFileSync(patchPath, "utf8"), /id: user-setting/);
    const backups = fs.readdirSync(directory).filter((name) => name.includes(".before-zhijian-reader-") && name.endsWith(".bak"));
    assert.ok(backups.length >= 1);
    assert.ok(backups.some((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")).dependencies["dsh-novel-reader"]));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
