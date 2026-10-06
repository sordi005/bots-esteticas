/** Una promesa que el test resuelve cuando quiere: sirve para frenar un handler a mitad de camino. */
export function gate(): { open: () => void; opened: Promise<void> } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}
