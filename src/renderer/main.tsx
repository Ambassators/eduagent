import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/unbounded/index.css';
import '@fontsource-variable/schibsted-grotesk/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import App from './App';
import './styles.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
