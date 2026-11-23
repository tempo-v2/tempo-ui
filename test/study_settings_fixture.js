import assert from "node:assert/strict";

export async function setIntroductionLimits(url, openings, tactics) {
  async function settings(command) {
    const response = await fetch(url + "/api/tactic-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    const reply = await response.json();
    assert.equal(response.status, 200, JSON.stringify(reply));
    assert.equal(reply.status, "tactic_settings");
    return reply;
  }
  const current = await settings({ command: "get" });
  const saved = await settings({
    command: "save",
    dataset_id: current.dataset_id,
    expected_revision: current.revision,
    new_openings_per_day: openings,
    new_tactics_per_day: tactics,
    selection: current.selection,
  });
  assert.equal(saved.new_openings_per_day, openings);
  assert.equal(saved.new_tactics_per_day, tactics);
}
