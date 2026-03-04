/**
 * Side panel entrypoint — renders the same App as the popup.
 * Chrome 114+ side_panel API. Persistent panel that doesn't close on focus loss.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '../popup/App';
import '../popup/style.css';
import { i18nConfig } from '@/components/i18nConfig';
import initTranslations from '@/components/i18n';

initTranslations(i18nConfig.defaultLocale, ['common']);

// Mark the document as side panel mode so CSS/Layout can adapt
document.documentElement.classList.add('sidepanel-mode');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
