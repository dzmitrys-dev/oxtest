import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Client, Provider, cacheExchange, fetchExchange } from 'urql';

import { App } from './App';
import './index.css';

/**
 * urql client for the Bonus A SPA.
 *
 * D-04: the client targets the RELATIVE `/graphql` URL — the built SPA is served
 * static by the API on the SAME origin, so there is no absolute host and no CORS
 * assumption. In local dev the Vite proxy (vite.config.ts) forwards `/graphql`
 * to the API on :3000.
 */
const client = new Client({
  url: '/graphql',
  exchanges: [cacheExchange, fetchExchange],
});

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <Provider value={client}>
      <App />
    </Provider>
  </StrictMode>,
);
