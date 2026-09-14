import assert from "node:assert/strict";
import test from "node:test";
import { mapRemoteState } from "../src/lifecycle.js";

test("an exited but unsettled worker is unknown rather than running", () => {
  assert.equal(mapRemoteState("working", "busy", false, false), "unknown");
  assert.equal(mapRemoteState("stopped", "stopped", false, true), "cancelled");
});
