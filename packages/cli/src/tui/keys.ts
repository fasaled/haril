/** Keyboard reference shown by the `help` command and the `?` overlay. */
export const KEYBOARD_HELP = `Sections
  Ctrl+F            files selector (press again to return to the prompt)
  Ctrl+E            events
  Ctrl+D            event detail (analyze)
  Tab               next section: files → events → detail → prompt (in the prompt: autocomplete)
  Esc or :          back to the prompt
  ?                 keyboard help (outside the prompt)
  Ctrl+Q            quit

Prompt
  Tab               autocomplete (repeat to cycle)
  ↑ / ↓             command history
  PgUp / PgDn       scroll output (also Shift+↑ / Shift+↓)

Files
  ← / →  (h / l)    previous / next file
  Home / End        first / last
  Enter             show its events
  /                 filter by name

Events
  ↑ / ↓             move (live: scroll)
  PgUp / PgDn       page
  Home / End        first / last (live: End follows new events)
  Enter             open detail
  /                 filter menu`;
