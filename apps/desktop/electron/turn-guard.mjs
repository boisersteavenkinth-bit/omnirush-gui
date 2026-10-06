// The don't-quit-mid-turn guard. The renderer reports whether a turn is
// running (`__setTurnRunning`); closing the window or quitting the app while
// one runs asks first, because a cut-off last turn keeps the session from
// counting as a Good session ★. "Wait for it" is the default (and Escape);
// "Quit anyway" goes ahead.

export const TURN_GUARD_TITLE = "A turn is still running.";
export const TURN_GUARD_DETAIL = "Quit now and this session won't count as a Good session ★.";
export const TURN_GUARD_BUTTONS = Object.freeze(["Wait for it", "Quit anyway"]);
const QUIT_ANYWAY = 1;

/**
 * @param {{
 *   showMessageBox: (window: import("electron").BrowserWindow | null, options: import("electron").MessageBoxOptions) => Promise<{ response: number }>,
 *   getWindow: () => import("electron").BrowserWindow | null,
 *   appName?: string,
 * }} deps
 */
export function createTurnGuard(deps) {
  let turnRunning = false;
  let quitConfirmed = false;
  /** @type {Promise<boolean> | null} */
  let asking = null;

  async function confirmLeave() {
    if (!turnRunning || quitConfirmed) return true;
    // A second close or quit while the dialog is open waits for the same answer.
    asking ??= deps.showMessageBox(deps.getWindow() ?? null, {
      type: "warning",
      title: deps.appName ?? "OmniRush.ai",
      message: TURN_GUARD_TITLE,
      detail: TURN_GUARD_DETAIL,
      buttons: [...TURN_GUARD_BUTTONS],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
      .then((result) => result.response === QUIT_ANYWAY)
      .catch(() => true)
      .finally(() => {
        asking = null;
      });
    return asking;
  }

  return {
    setTurnRunning(value) {
      turnRunning = value === true;
      return turnRunning;
    },
    isTurnRunning() {
      return turnRunning;
    },
    /**
     * `before-quit`: returns true when the quit may go on now. Otherwise it
     * has prevented the event and quits again (`quit`) once the user picks
     * "Quit anyway".
     */
    guardQuit(event, quit) {
      if (!turnRunning || quitConfirmed) return true;
      event.preventDefault();
      void confirmLeave().then((leave) => {
        if (!leave) return;
        quitConfirmed = true;
        quit();
      });
      return false;
    },
    /**
     * The window's `close`: the same question; "Quit anyway" closes it
     * (`close`), which quits the app where closing the last window does.
     */
    guardClose(event, close) {
      if (!turnRunning || quitConfirmed) return true;
      event.preventDefault();
      void confirmLeave().then((leave) => {
        if (!leave) return;
        quitConfirmed = true;
        close();
      });
      return false;
    },
    /** A window opened again (macOS keeps the app running): ask next time too. */
    reset() {
      quitConfirmed = false;
    },
  };
}
