import { expect } from "vitest";
import { eventually, spec } from "@omnirush/testkit";
import { artifactHtmlPreviewWorld, previewCanaryKey, previewFileName, previewWitnessKey } from "../worlds/artifact-html-preview.ts";

const test = spec.world(artifactHtmlPreviewWorld);

test("HTML artifacts render scripted charts without access to the desktop app", async ({ world, user, probe, step, evidence }) => {
  await user.press("Escape");
  await user.click("Select tab: overflow-tab-12.md");
  await user.see({ placeholder: "Search files" }, { timeoutMs: 30_000 });
  await user.click("Refresh workspace files");
  await user.type({ placeholder: "Search files" }, previewFileName);
  const file = await eventually(() => world.htmlFile(), { within: 30_000, until: (value) => value?.hitTestOk === true });
  if (!file) throw new Error("The HTML file is not visible in the workspace tree.");
  expect(file.path).toBe(previewFileName);
  await world.clickHtmlFile(file.center);
  await user.see(`Select tab: ${previewFileName}`, { timeoutMs: 30_000 });

  const witness = await eventually(() => probe.storage(previewWitnessKey), {
    within: 30_000,
    until: (value) => value !== null,
  });

  await step("The visible HTML preview still renders and runs chart scripts", async () => {
    const frame = await probe.dom(`iframe[title="${previewFileName}"]`);
    expect(frame.elements).toHaveLength(1);
    expect(frame.elements[0]?.rect.width).toBeGreaterThan(0);
    expect(frame.elements[0]?.rect.height).toBeGreaterThan(0);
    expect(witness).toMatchObject({ headingRendered: true, chartUpdated: true });
    evidence.recordAssertionEvidence("HTML and chart scripts continue working in a visible preview", JSON.stringify({ frame: frame.elements, witness }), true);
    await user.screenshot();
  });

  await step("Preview scripts cannot read or modify parent state or invoke the desktop bridge", async () => {
    const expected = {
      origin: "null",
      parentDomReadable: false,
      parentStorageReadable: false,
      parentStorageWritable: false,
      parentBridgeReachable: false,
      parentDesktopCallSucceeded: false,
    };
    const canary = await probe.storage(previewCanaryKey);
    const blocked = typeof witness === "object" && witness !== null
      && Object.entries(expected).every(([key, value]) => Reflect.get(witness, key) === value)
      && canary === "dummy-parent-value";
    evidence.recordAssertionEvidence("The preview cannot access parent DOM, storage, or desktop commands", JSON.stringify({ expected, witness, canary }), blocked);
    expect(witness).toMatchObject(expected);
    expect(canary).toBe("dummy-parent-value");
  });
});
