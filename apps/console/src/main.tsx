import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppShell } from './shell/AppShell.js';
import { SignIn } from './shell/SignIn.js';
import './shell.css';

const rootElement = document.querySelector('#root');

if (rootElement === null) {
  throw new Error('Atlas console root element is missing');
}

createRoot(rootElement).render(
  <StrictMode>
    <SignIn>
      <AppShell />
    </SignIn>
  </StrictMode>,
);
