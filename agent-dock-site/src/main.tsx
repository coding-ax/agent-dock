import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { LangProvider } from './lib/i18n';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <LangProvider>
        <App />
      </LangProvider>
    </MotionConfig>
  </StrictMode>
);
