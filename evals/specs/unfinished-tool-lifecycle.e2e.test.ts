import { spec } from "@omnirush/testkit";
import { arrangeControl, unfinishedTools } from "../worlds/chat.ts";

const test = spec.world(unfinishedTools);

test("unfinished current-turn tools expose active, waiting, and unknown outcomes", async ({ world, user, seed, step }) => {
  await step("active unfinished tools remain visibly in progress", async () => {
    await user.see("Running command, reading 1 file");
    await user.click({ role: "button", label: /Running command/ });
    await user.see({ text: /Check OmniRush repository state/ });
    await user.see({ text: /git status --short --branch # OmniRush/ });
    await user.notSee({ text: /OpenCode repository state/ });
    await user.notSee({ text: /git status --short --branch # OpenCode/ });
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "waiting" });
  await step("a blocked unfinished step says what it needs", async () => {
    await user.see({ text: /Waiting for your action/ });
    await user.see({ text: "Choose an option or approve the request to continue." });
    await user.notSee("Running command, reading 1 file");
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "idle" });
  await step("idle unfinished tools expose an unknown terminal state", async () => {
    await user.see({ text: /Status unknown/ });
    await user.see({ text: "No terminal result was observed. This step may still be running; check the session before retrying." });
    await user.notSee({ text: /Waiting for your action/ });
    await user.notSee("Running command, reading 1 file");
  });

  await step("guarded browser permission labels and details use OmniRush", async () => {
    await arrangeControl(seed, world.app, "eval.child_permission.seed", { browserBranding: true });
    await arrangeControl(seed, world.app, "eval.task_activity.seed", {
      childSessionId: `${world.session.sessionId}:eval-child`,
    });
    await user.see({ text: "Approve omnirush-chrome-devtools_browser_open?" });
    await user.notSee({ text: /opencode/i });
    // Seeded tool events need no model; dismiss the fixture's empty model picker.
    await user.press("Escape");
    await user.click({ text: "Details" });
    await user.see({ text: /OmniRush browser access/ });
    await user.notSee({ text: /opencode/i });
    await user.click("Allow once");
    await user.notSee({ text: "Approve omnirush-chrome-devtools_browser_open?" });
    await user.notSee({ text: /Requested by Investigate the deployment failure/ });
  });
});
