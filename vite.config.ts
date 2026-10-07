import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages는 저장소 이름 아래 경로(/microneedle-ipc/)로, Firebase 호스팅은 최상위 경로(/)로 서비스된다
export default defineConfig(({ mode }) => ({
  base: mode === 'hosting' ? '/' : '/microneedle-ipc/',
  build: { outDir: mode === 'hosting' ? 'dist-hosting' : 'dist' },
  plugins: [react(), tailwindcss()],
}))
