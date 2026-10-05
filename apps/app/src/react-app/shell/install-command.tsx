/** @jsxImportSource react */

/** The command that installs a downloaded package, with the package's folder one click away. */
export function InstallCommand(props: { command: string; onShowFile?: (() => void) | null; tone?: "dark" | "light" }) {
  const dark = props.tone !== "light";
  return (
    <div data-testid="update-install-command" className="mt-4 w-full">
      <pre className={dark
        ? "overflow-x-auto rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-emerald-100 select-text"
        : "overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground select-text"}
      >{props.command}</pre>
      {props.onShowFile ? (
        <button
          type="button"
          onClick={props.onShowFile}
          className={dark
            ? "mt-2 text-xs font-medium text-white/60 underline-offset-4 hover:text-white hover:underline mac:titlebar-no-drag"
            : "mt-2 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"}
        >
          Show the downloaded file
        </button>
      ) : null}
    </div>
  );
}
