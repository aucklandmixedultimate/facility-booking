import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  base: '/facility-booking/',
  build: {
    rollupOptions: {
      // Two pages: the booking app, and the admin council-field vetting tool.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        vetting: resolve(import.meta.dirname, 'vetting.html'),
      },
    },
  },
})