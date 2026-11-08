// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { connect } from './lib/store.ts';
import { applyTheme } from './lib/theme.ts';
import { RecordPage } from './pages/Record.tsx';
import './styles/base.css';
import './styles/components.css';
import './styles/cinema.css';
import './styles/images.css';
import './styles/studio.css';
import './styles/app.css';
import './styles/sites.css';
import './styles/first-run.css';
import './styles/making.css';

// Before the first render, so a light Studio never flashes dark.
applyTheme();
// A link from a chat (/record/<token>) opens the record page alone: no account, and no connection to the rest of the
// Studio, since the token is all it has.
const record = /^\/record\/([A-Za-z0-9_-]{43})$/.exec(location.pathname)?.[1];
if (!record) void connect();
createRoot(document.getElementById('root')!).render(
  <StrictMode>{record ? <RecordPage token={record} /> : <App />}</StrictMode>,
);
