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
      assert.equal(m.id, "dsh-novel-reader");
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
  assert.equal(definition.kind, "novel-reader");
  assert.equal(registration.key, definition.id);
  assert.equal(definition.guide[0].title(), "小说阅读器");
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
    assert.deepEqual(m.dsh.profile.bundles, ["existing", "dsh-novel-reader"]);
    assert.equal(m.dependencies.existing, "1.0.0");
    assert.equal(
      fs.readFileSync(path.join(directory, "cordis.patch.yml"), "utf8"),
      "# preserve me\n[]",
    );
    assert.ok(
      fs.existsSync(
        path.join(directory, "node_modules/dsh-novel-reader/lib/client.js"),
      ),
    );
    fs.writeFileSync(path.join(directory, "lock"), "1");
    assert.throws(run);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
