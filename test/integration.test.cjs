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
  assert.deepEqual(Array.from(plugin.inject), ["slots", "sidebarRightTabs", "sessions", "uiSession"]);
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
  assert.equal(typeof browser.ZhijianReaderCore.decode, "function");
  assert.equal(browser.NovelReaderCore, undefined);
  assert.equal(definition.guide[0].title(), "纸间 · 小说阅读器");
  disposers.reverse().forEach((fn) => fn?.());
  assert.equal(removed, true);
});
test("renamed installer disables the legacy entry without deleting its files or user overrides", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zhijian-migration-"));
  try {
    const manifestPath = path.join(directory, "package.json");
    fs.writeFileSync(manifestPath, JSON.stringify({
      private: true,
      dependencies: { existing: "1.0.0", "dsh-novel-reader": "file:./plugins/dsh-novel-reader" },
      dsh: { profile: { bundles: ["existing", "dsh-novel-reader", "dsh-zhijian-reader", "dsh-novel-reader"] } },
    }));
    const legacyDirectory = path.join(directory, "plugins/dsh-novel-reader");
    fs.mkdirSync(legacyDirectory, { recursive: true });
    fs.writeFileSync(path.join(legacyDirectory, "keep-me.txt"), "legacy rollback files");
    fs.writeFileSync(path.join(directory, "cordis.patch.yml"), "# user overrides\n[]\n");
    const run = () => cp.execFileSync(process.execPath,
      [path.join(__dirname, "../install.mjs"), "--profile", directory], { stdio: "pipe" });
    run();
    run();
    const installed = JSON.parse(fs.readFileSync(manifestPath));
    assert.deepEqual(installed.dsh.profile.bundles, ["existing", "dsh-zhijian-reader"]);
    assert.equal(installed.dependencies["dsh-novel-reader"], undefined);
    assert.equal(installed.dependencies["dsh-zhijian-reader"], "file:./plugins/dsh-zhijian-reader");
    assert.equal(installed.dependencies.existing, "1.0.0");
    assert.equal(fs.readFileSync(path.join(legacyDirectory, "keep-me.txt"), "utf8"), "legacy rollback files");
    assert.equal(fs.readFileSync(path.join(directory, "cordis.patch.yml"), "utf8"), "# user overrides\n[]\n");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
      for (const file of ["locale/zh.json", "locale/en.json", "icon.svg", "LICENSE"]) {
        assert.ok(fs.existsSync(path.join(directory, target, "dsh-zhijian-reader", file)), "Missing installed " + file);
      }
    }
    fs.writeFileSync(path.join(directory, "lock"), "1");
    assert.throws(run);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
