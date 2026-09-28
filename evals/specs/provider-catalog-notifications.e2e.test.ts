import { expect } from "vitest";
import { control, readAvailableModels } from "@omnirush/behaviors";
import { eventually, spec } from "@omnirush/testkit";
import { providerCatalogNotifications } from "../worlds/chat.ts";

const test = spec.world(providerCatalogNotifications, { timeout: 600_000 });

function providerNotifications(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Notification center did not return an array.");
  return value.filter((entry) => typeof entry === "object" && entry !== null && Reflect.get(entry, "kind") === "providers");
}

test("catalog refreshes announce new models once and keep metadata updates and reconnects quiet", async ({ world, user, step, evidence }) => {
  const notifications = async () => providerNotifications(await control(world.app, "notifications.list"));
  const models = () => readAvailableModels(world.app);
  await eventually(models, {
    within: 60_000,
    label: "baseline catalog available",
    until: (rows) => rows.some((model) => model.id === world.modelIds[0]),
  });
  await user.press("Escape");
  await user.click({ role: "button", label: /^Notifications/ });
  if ((await notifications()).length > 0) await user.click({ role: "button", label: "Clear all" });
  await user.press("Escape");
  expect(await notifications()).toHaveLength(0);

  await step("a metadata refresh updates the picker without announcing 41 new models", async () => {
    await world.updateCatalog(world.modelIds, 1);
    await eventually(async () => (await models()).some((model) => model.name === world.modelIds[0] + " revision 1"), {
      within: 60_000, label: "updated model metadata visible", until: (value) => value === true,
    });
    const entries = await notifications();
    evidence.recordAssertionEvidence("Metadata updates do not announce existing models", "The picker shows revision 1; notifications=" + JSON.stringify(entries), entries.length === 0);
    expect(entries).toHaveLength(0);
    await user.press("Escape");
  });

  await step("a disconnected provider returns without being announced again", async () => {
    await world.updateCatalog(world.modelIds, 1, true);
    await eventually(async () => (await models()).every((model) => model.id !== world.modelIds[0]), {
      within: 60_000, label: "provider disconnected", until: (value) => value === true,
    });
    await user.press("Escape");
    await world.updateCatalog(world.modelIds, 1);
    await eventually(async () => (await models()).some((model) => model.id === world.modelIds[0]), {
      within: 60_000, label: "provider reconnected", until: (value) => value === true,
    });
    const entries = await notifications();
    evidence.recordAssertionEvidence("Reconnecting does not announce the same provider and models", "The existing model disappeared and returned; notifications=" + JSON.stringify(entries), entries.length === 0);
    expect(entries).toHaveLength(0);
    await user.press("Escape");
  });

  await step("a genuinely new model produces one announcement", async () => {
    const expanded = [...world.modelIds, "catalog-new-model"];
    await world.updateCatalog(expanded, 2);
    await eventually(async () => (await models()).some((model) => model.id === "catalog-new-model"), {
      within: 60_000, label: "new model selectable", until: (value) => value === true,
    });
    await eventually(notifications, { within: 10_000, label: "new model notification", until: (value) => value.length === 1 });
    const entries = await notifications();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: "1 new model available" });
    await user.press("Escape");
    await user.click({ role: "button", label: /^Notifications/ });
    await user.see({ text: "1 new model available" });
    await user.click({ role: "button", label: "Clear all" });
    await user.press("Escape");

    await world.updateCatalog(expanded, 3);
    await eventually(async () => (await models()).some((model) => model.name === "catalog-new-model revision 3"), {
      within: 60_000, label: "repeated refresh settled", until: (value) => value === true,
    });
    const afterRefresh = await notifications();
    expect(afterRefresh).toHaveLength(0);
    evidence.recordAssertionEvidence("A new model is announced once, including after the notification is cleared", "New-model notifications=" + JSON.stringify(entries) + "; after refresh=" + JSON.stringify(afterRefresh), entries.length === 1 && afterRefresh.length === 0);
  });
});
