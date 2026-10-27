// A scanned code passed from one page to the next (Scan -> Cash out, prefilled), in memory only:
// a reload starts the page empty rather than replaying a code from the URL or storage.
let pending: { path: string; text: string } | null = null;

export function handOff(path: string, text: string) {
  pending = { path, text };
}

/** The code handed to `path`, once. */
export function takeHandoff(path: string): string | null {
  if (pending?.path !== path) return null;
  const { text } = pending;
  pending = null;
  return text;
}
