import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useControlAction, type OmniRushControlAction } from "./control/control-provider";

type Choice = "pending" | "accept" | "decline" | "done";
type Offer = { sessionID: string; offerID: string; scopes: string; choice: Choice; error?: string };
type WrapStore = {
  offers: Offer[];
  offer: (sessionID: string, offerID: string, scopes: string) => Choice;
  choose: (sessionID: string, offerID: string, choice: Choice, error?: string) => void;
  clear: (sessionID: string, offerID: string) => void;
};

const useWrapStore = create<WrapStore>()(persist((set, get) => ({
  offers: [],
  offer: (sessionID, offerID, scopes) => {
    const existing = get().offers.find((entry) => entry.sessionID === sessionID && entry.offerID === offerID);
    if (existing) return existing.choice;
    set((state) => ({ offers: [
      { sessionID, offerID, scopes, choice: "pending" },
      ...state.offers.filter((entry) => entry.sessionID !== sessionID),
    ] }));
    return "pending";
  },
  choose: (sessionID, offerID, choice, error) => set((state) => ({
    offers: state.offers.map((entry) => entry.sessionID === sessionID && entry.offerID === offerID
      ? { ...entry, choice, error } : entry),
  })),
  clear: (sessionID, offerID) => set((state) => ({
    offers: state.offers.filter((entry) => entry.sessionID !== sessionID || entry.offerID !== offerID),
  })),
}), {
  name: "omnirush:budget-wrap-consent:v1",
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({ offers: state.offers }),
}));

function fields(args: unknown): { sessionID: string; offerID: string; scopes: string } | null {
  if (!args || typeof args !== "object") return null;
  if (!("sessionID" in args) || !("offerID" in args)
    || typeof args.sessionID !== "string" || typeof args.offerID !== "string") return null;
  const sessionID = args.sessionID.trim();
  const offerID = args.offerID.trim();
  if (!sessionID || !offerID) return null;
  return { sessionID, offerID, scopes: "scopes" in args && typeof args.scopes === "string" ? args.scopes : "" };
}

/** The choice stays on screen, and in local storage, until the person answers. */
export function BudgetWrapConsent() {
  const offers = useWrapStore((state) => state.offers);
  const pending = offers.find((entry) => entry.choice === "pending");

  const updateAction = useMemo<OmniRushControlAction>(() => ({
    id: "budget.wrap.update",
    label: "Update pending quota wrap",
    description: "Show or settle a local, user-approved context wrap offer.",
    // The engine syncs a local offer through the query mailbox, so polling
    // does not turn on Control Mode or trigger its visible action animation.
    kind: "query",
    sideEffect: "none",
    requiresArgs: true,
    execute: (args) => {
      const parsed = fields(args);
      if (!parsed || !args || typeof args !== "object") return { ok: false, error: "Invalid wrap offer" };
      const operation = "operation" in args ? args.operation : undefined;
      const store = useWrapStore.getState();
      if (operation === "offer") return { choice: store.offer(parsed.sessionID, parsed.offerID, parsed.scopes) };
      if (operation === "finish") store.choose(parsed.sessionID, parsed.offerID, "done");
      else if (operation === "fail") store.choose(parsed.sessionID, parsed.offerID, "pending", "The wrap could not finish. Choose whether to retry.");
      else if (operation === "clear") store.clear(parsed.sessionID, parsed.offerID);
      else return { ok: false, error: "Unknown wrap operation" };
      return { ok: true };
    },
  }), []);
  useControlAction(updateAction);

  return <Dialog open={Boolean(pending)} onOpenChange={() => undefined}>
    <DialogContent showCloseButton={false} data-testid="budget-wrap-consent">
      <DialogHeader>
        <DialogTitle>Save a handoff for this session?</DialogTitle>
        <DialogDescription>
          Your {pending?.scopes.replace(",", " and ") || "token"} allowance is nearly used. A wrap saves a summary of this session so you can resume it later. You can keep working while tokens remain, whether you wrap or not.
        </DialogDescription>
      </DialogHeader>
      {pending?.error ? <p className="text-sm text-destructive">{pending.error}</p> : null}
      <DialogFooter>
        <Button variant="outline" data-testid="budget-wrap-decline" onClick={() => {
          if (pending) useWrapStore.getState().choose(pending.sessionID, pending.offerID, "decline");
        }}>Keep working</Button>
        <Button data-testid="budget-wrap-accept" onClick={() => {
          if (pending) useWrapStore.getState().choose(pending.sessionID, pending.offerID, "accept");
        }}>Wrap up</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
