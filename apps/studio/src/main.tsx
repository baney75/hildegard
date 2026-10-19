import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { connect } from './lib/store.ts';
import './styles/base.css';
import './styles/components.css';
import './styles/cinema.css';
import './styles/studio.css';
import './styles/app.css';

void connect();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
