// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { connect } from './lib/store.ts';
import { applyTheme } from './lib/theme.ts';
import './styles/base.css';
import './styles/components.css';
import './styles/cinema.css';
import './styles/studio.css';
import './styles/app.css';

// Before the first render, so a light Studio never flashes dark.
applyTheme();
void connect();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
