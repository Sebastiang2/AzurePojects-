import assert from "node:assert/strict";
import test from "node:test";

import { appsToVerify } from "../apps-to-verify.mjs";

const manifest = {
  apps: {
    existing: {},
    studio: { introducedBy: "studio-web-a" },
  },
};

test("an absent newly introduced app does not block an unrelated deployment", () => {
  assert.deepEqual(appsToVerify(manifest, "main", ["existing"]), ["existing"]);
});

test("the introducing deployment must verify its app", () => {
  assert.deepEqual(appsToVerify(manifest, "studio-web-a", ["existing"]), ["existing", "studio"]);
});

test("a live introduced app is verified by every deployment", () => {
  assert.deepEqual(appsToVerify(manifest, "main", ["existing", "studio"]), ["existing", "studio"]);
});

test("a failed live-site listing verifies everything", () => {
  assert.deepEqual(appsToVerify(manifest, "main", ["*"]), ["existing", "studio"]);
});
