import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';
import './styles/index.css';
import {
  isChunkLoadError,
  executeVersionRecovery,
  clearRecoveryCounters,
} from './app/utils/versionRecovery';

// ============================================================
// 全局 Chunk 加载失败恢复
// 捕获 React 组件树外的动态 import() 失败（如路由懒加载），
// 走 soft recovery（清 shell 缓存 + reload），多次失败才 /sw-reset。
// ============================================================

window.addEventListener('unhandledrejection', (event) => {
  if (!isChunkLoadError(event.reason)) return;

  // 离线：不刷新、不清缓存、不跳转，完全静默（用户留在当前页）
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    event.preventDefault();
    return;
  }

  console.warn('[main] Chunk load error caught globally, attempting soft recovery...');
  event.preventDefault();
  void executeVersionRecovery();
});

// 成功加载后清除重试计数器
window.addEventListener('load', () => {
  clearRecoveryCounters();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
