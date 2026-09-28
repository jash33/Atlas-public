import { useEffect, useRef } from 'react';

type DismissibleDetails = Pick<HTMLDetailsElement, 'contains' | 'open'>;

export function dismissDetailsFromOutside(
  details: DismissibleDetails | null,
  target: EventTarget | null,
) {
  if (details?.open && target && !details.contains(target as Node)) details.open = false;
}

export function useDismissibleDetails() {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const dismiss = (event: PointerEvent) =>
      dismissDetailsFromOutside(detailsRef.current, event.target);
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);

  return detailsRef;
}
