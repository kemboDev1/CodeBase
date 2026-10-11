import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './styles/pages.css';
import { AppProvider } from './state/AppContext.jsx';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
