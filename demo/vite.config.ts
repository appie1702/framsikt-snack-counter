import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The demo imports the real, tested core logic from ../src (no copy, no mock).
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: ['..'] } },
});
