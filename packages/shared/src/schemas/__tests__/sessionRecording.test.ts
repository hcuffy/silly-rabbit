import { describe, expect, it } from "vitest";
import { NetworkCaptureSchema, SessionRecordingSchema, SessionRecordingStepSchema } from "../sessionRecording.js";

describe("SessionRecordingStepSchema", () => {
  it("parses a role-strategy click step", () => {
    const result = SessionRecordingStepSchema.parse({
      action: "click",
      selectorStrategy: "role",
      role: "button",
      accessibleName: "Save",
      timestampOffsetMs: 1200,
    });
    expect(result.action).toBe("click");
  });

  it("parses a css-strategy fill step with a value", () => {
    const result = SessionRecordingStepSchema.parse({
      action: "fill",
      selectorStrategy: "css",
      cssSelector: "#name-field",
      value: "Main Warehouse",
      timestampOffsetMs: 3400,
    });
    expect(result.value).toBe("Main Warehouse");
  });

  it("parses a navigate step (value holds the URL)", () => {
    const result = SessionRecordingStepSchema.parse({
      action: "navigate",
      selectorStrategy: "css",
      value: "https://dev.rabbit.example/fleet/locations",
      timestampOffsetMs: 500,
    });
    expect(result.action).toBe("navigate");
    expect(result.value).toBe("https://dev.rabbit.example/fleet/locations");
  });

  it("rejects an unknown action", () => {
    expect(() =>
      SessionRecordingStepSchema.parse({
        action: "hover",
        selectorStrategy: "css",
        cssSelector: "#x",
        timestampOffsetMs: 0,
      }),
    ).toThrow();
  });

  it("rejects an unknown selectorStrategy", () => {
    expect(() =>
      SessionRecordingStepSchema.parse({
        action: "click",
        selectorStrategy: "xpath",
        timestampOffsetMs: 0,
      }),
    ).toThrow();
  });
});

describe("SessionRecordingSchema", () => {
  it("parses a valid recording with multiple steps", () => {
    const result = SessionRecordingSchema.parse({
      sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      targetBaseUrl: "https://dev.rabbit.example",
      recordedAt: new Date(),
      steps: [
        { action: "navigate", selectorStrategy: "css", value: "https://dev.rabbit.example/fleet/locations", timestampOffsetMs: 0 },
        { action: "click", selectorStrategy: "role", role: "link", accessibleName: "Locations", timestampOffsetMs: 800 },
      ],
    });
    expect(result.steps).toHaveLength(2);
  });

  it("parses a recording with zero steps (recording started, nothing captured yet)", () => {
    const result = SessionRecordingSchema.parse({
      sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      targetBaseUrl: "https://dev.rabbit.example",
      recordedAt: new Date(),
      steps: [],
    });
    expect(result.steps).toHaveLength(0);
  });

  it("rejects a recording with a non-uuid sessionId", () => {
    expect(() =>
      SessionRecordingSchema.parse({
        sessionId: "not-a-uuid",
        targetBaseUrl: "https://dev.rabbit.example",
        recordedAt: new Date(),
        steps: [],
      }),
    ).toThrow();
  });

  it("rejects a recording missing targetBaseUrl", () => {
    expect(() =>
      SessionRecordingSchema.parse({
        sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        recordedAt: new Date(),
        steps: [],
      }),
    ).toThrow();
  });

  it("parses a recording with networkCaptures set (session-replay-spec §5.3)", () => {
    const result = SessionRecordingSchema.parse({
      sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      targetBaseUrl: "https://dev.rabbit.example",
      recordedAt: new Date(),
      steps: [],
      networkCaptures: [
        {
          url: "https://dev.rabbit.example/api/locations",
          method: "GET",
          status: 200,
          bodyPath: "./session-captures/9b1deb4d/0.json",
          timestampOffsetMs: 450,
        },
      ],
    });
    expect(result.networkCaptures).toHaveLength(1);
  });

  it("parses a recording with no networkCaptures field at all (additive, backward-compatible)", () => {
    const result = SessionRecordingSchema.parse({
      sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      targetBaseUrl: "https://dev.rabbit.example",
      recordedAt: new Date(),
      steps: [],
    });
    expect(result.networkCaptures).toBeUndefined();
  });
});

describe("NetworkCaptureSchema", () => {
  it("parses a valid network capture", () => {
    const result = NetworkCaptureSchema.parse({
      url: "https://dev.rabbit.example/api/locations",
      method: "GET",
      status: 200,
      bodyPath: "./session-captures/9b1deb4d/0.json",
      timestampOffsetMs: 450,
    });
    expect(result.status).toBe(200);
    expect(result.bodyPath).toBe("./session-captures/9b1deb4d/0.json");
  });

  it("rejects a capture missing bodyPath", () => {
    expect(() =>
      NetworkCaptureSchema.parse({
        url: "https://dev.rabbit.example/api/locations",
        method: "GET",
        status: 200,
        timestampOffsetMs: 450,
      }),
    ).toThrow();
  });
});
