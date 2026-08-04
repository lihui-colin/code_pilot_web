import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { CodexChat } from './CodexChat.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname === '/codex-chat' ? <CodexChat /> : <App />}
  </StrictMode>,
);
