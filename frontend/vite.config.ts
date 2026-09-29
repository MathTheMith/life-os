import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // The Enable Banking bank-sync callback (/api/banksync/callback) and
        // static downloads (/dl/...) are both real top-level navigations to
        // this origin that must NOT be served the cached app shell — without
        // this denylist the service worker's SPA fallback intercepts them
        // like any other route change.
        navigateFallbackDenylist: [/^\/api\//, /^\/dl\//],
      },
      manifest: {
        name: 'Life OS',
        short_name: 'Life OS',
        description: 'Finances, motorsport et assistant perso',
        theme_color: '#111111',
        background_color: '#111111',
        display: 'standalone',
        icons: [
          { src: 'pwa-192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: 'pwa-512.svg', sizes: '512x512', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
