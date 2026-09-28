import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

// Run hooks with React's actual scheduling, effects, and cleanup.
export function renderHook<T>(useValue: () => T) {
  const container = document.createElement('div');
  const root = createRoot(container);
  let current: T;
  function Probe() {
    current = useValue();
    return null;
  }
  function render() {
    act(() => root.render(createElement(Probe)));
  }
  render();
  return {
    get current() {
      return current;
    },
    render,
    unmount() {
      act(() => root.unmount());
    },
  };
}
