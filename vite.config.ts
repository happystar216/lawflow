import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['exceljs', 'docx', 'file-saver'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
    target: 'es2020',
    rollupOptions: {
      treeshake: {
        moduleSideEffects: (id) => !id.includes('node_modules/pdfjs-dist')
      },
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'echarts-vendor': ['echarts', 'echarts-for-react'],
          'office-vendor': ['exceljs', 'docx', 'file-saver'],
          'pdfjs-vendor': ['pdfjs-dist']
        }
      }
    }
  }
});
