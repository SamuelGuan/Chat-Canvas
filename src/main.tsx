/**
 * src/main.tsx
 * 应用入口：先完成 v0.4 存储启动序列（三级文件装载 + 自愈），再挂载 React。
 * bootstrap 失败时回退默认空画布（不阻塞应用启动），错误打印到控制台。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useCanvasStore } from '@/store/useCanvasStore';
import './styles/globals.css';
import 'katex/dist/katex.min.css';

async function main() {
  try {
    await useCanvasStore.getState().bootstrap();
  } catch (e) {
    console.error('[bootstrap] 数据装载失败，回退默认空画布', e);
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void main();
