import { describe, expect, it } from "vitest";
import { deriveFingerprint } from "../fingerprint.js";

const SNAPSHOT_EN = `
- heading "Locations" [level=1]
- list:
  - listitem:
    - text "5 vehicles"
  - listitem:
    - text "Created 2024-06-21T10:00:00Z"
- status "Loading":
  - text "Please wait"
`;

const SNAPSHOT_DE = `
- heading "Standorte" [level=1]
- list:
  - listitem:
    - text "5 Fahrzeuge"
  - listitem:
    - text "Erstellt 2024-06-22T09:15:00Z"
`;

const SNAPSHOT_STRUCTURAL_CHANGE = `
- heading "Locations" [level=1]
- list:
  - listitem:
    - text "5 vehicles"
  - listitem:
    - text "Created 2024-06-21T10:00:00Z"
  - listitem:
    - text "Extra row"
`;

describe("deriveFingerprint — stability golden fixtures (engine-spec §6, §4 highest-risk)", () => {
  it("is stable across locale + timestamp value + transient-node presence (volatile-only diff)", () => {
    const en = deriveFingerprint(SNAPSHOT_EN);
    const de = deriveFingerprint(SNAPSHOT_DE);
    expect(en.fingerprint).toBe(de.fingerprint);
  });

  it("changes when the tree structure genuinely changes", () => {
    const baseline = deriveFingerprint(SNAPSHOT_EN);
    const changed = deriveFingerprint(SNAPSHOT_STRUCTURAL_CHANGE);
    expect(baseline.fingerprint).not.toBe(changed.fingerprint);
  });

  it("drops box coordinates entirely — sub-pixel jitter never changes the fingerprint", () => {
    const withoutBox = deriveFingerprint('- button "Submit"');
    const withBox = deriveFingerprint('- button "Submit" [box="10,20,100,40"]');
    expect(withoutBox.fingerprint).toBe(withBox.fingerprint);
  });

  it("drops transient roles (alert/status/progressbar) and their subtree", () => {
    const withoutTransient = deriveFingerprint('- heading "Locations" [level=1]');
    const withTransient = deriveFingerprint('- heading "Locations" [level=1]\n- status "Loading":\n  - text "Please wait"');
    expect(withoutTransient.fingerprint).toBe(withTransient.fingerprint);
  });

  it("is sensitive to a real count going to zero (numbers are preserved, not masked away)", () => {
    const five = deriveFingerprint('- text "5 vehicles"');
    const zero = deriveFingerprint('- text "0 vehicles"');
    expect(five.fingerprint).not.toBe(zero.fingerprint);
  });
});
