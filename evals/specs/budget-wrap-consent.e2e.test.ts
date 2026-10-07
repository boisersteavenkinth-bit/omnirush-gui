import { expect } from "vitest";
import { browserScript, spec } from "@omnirush/testkit";
import { shimmerChat } from "../worlds/chat.ts";

const test = spec.world(shimmerChat);

test("a quota handoff waits for a choice, honors decline, and offers again after the allowance changes", async ({ user, probe, step, evidence }) => {
  const offer = (offerID: string, operation = "offer") => probe.eval(
    browserScript(async (inputOfferID: string, inputOperation: string) => {
      const control = window.__omnirushControl;
      const connection = {
        port: localStorage.getItem("omnirush.server.port"),
        token: localStorage.getItem("omnirush.server.token"),
      };
      if (!control || !connection.port || !connection.token) throw new Error("Desktop control server unavailable");
      const response = await fetch(`http://127.0.0.1:${connection.port}/experimental/ui-control/request`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "query", input: {
          id: "budget.wrap.update",
          args: { sessionID: "ses_budget_journey", offerID: inputOfferID, scopes: "day,week", operation: inputOperation },
        } }),
      });
      if (!response.ok) throw new Error(`Control mailbox returned ${response.status}`);
      return response.json();
    }, [offerID, operation]),
    { awaitPromise: true },
  );

  await step("the offer stays visible until answered", async () => {
    expect(await offer("allowance-one")).toMatchObject({ ok: true, result: { choice: "pending" } });
    await user.see({ testId: "budget-wrap-consent" });
    await user.see({ role: "button", label: "Wrap up" });
    await user.see({ role: "button", label: "Keep working" });
    expect(await offer("allowance-one")).toMatchObject({ ok: true, result: { choice: "pending" } });
    await user.see({ testId: "budget-wrap-consent" });
  });

  await step("declining suppresses that allowance's offer", async () => {
    await user.click({ role: "button", label: "Keep working" });
    await user.notSee({ testId: "budget-wrap-consent" });
    expect(await offer("allowance-one")).toMatchObject({ ok: true, result: { choice: "decline" } });
    await user.notSee({ testId: "budget-wrap-consent" });
  });

  await step("a changed allowance asks again, and acceptance closes the offer", async () => {
    expect(await offer("allowance-two")).toMatchObject({ ok: true, result: { choice: "pending" } });
    await user.see({ testId: "budget-wrap-consent" });
    await user.click({ role: "button", label: "Wrap up" });
    await user.notSee({ testId: "budget-wrap-consent" });
    expect(await offer("allowance-two")).toMatchObject({ ok: true, result: { choice: "accept" } });
    expect(await offer("allowance-two", "finish")).toMatchObject({ ok: true });
    expect(await offer("allowance-two")).toMatchObject({ ok: true, result: { choice: "done" } });
  });

  evidence.recordAssertionEvidence(
    "An unanswered wrap stays visible; decline is remembered for one allowance; a changed allowance asks again",
    "The desktop shell showed a persistent choice for the first offer. Decline dismissed it and subsequent sync returned decline. A second allowance reopened it; acceptance and completion dismissed it without a stop screen.",
    true,
  );
});
