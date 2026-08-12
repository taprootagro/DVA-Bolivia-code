import { useEffect } from "react";

/**
 * 性能监控Hook - 使用现代 PerformanceNavigationTiming API
 * 
 * 功能：
 * - 监控页面加载性能（替换已废弃的 performance.timing）
 * - 检测低端设备
 * - 在控制台输出性能报告
 */
export function usePerformanceMonitor(pageName: string) {
  useEffect(() => {
    // 检查是否为低端设备
    const isLowEndDevice = () => {
      const hardwareConcurrency = navigator.hardwareConcurrency || 2;
      const deviceMemory = (navigator as any).deviceMemory || 4;
      return hardwareConcurrency <= 4 || deviceMemory <= 2;
    };

    // 使用现代 PerformanceNavigationTiming API
    const getPerformanceMetrics = () => {
      const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      if (!entries || entries.length === 0) return null;

      const nav = entries[0];
      return {
        // DNS查询耗时
        dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
        // TCP连接耗时
        tcp: Math.round(nav.connectEnd - nav.connectStart),
        // 请求耗时
        request: Math.round(nav.responseEnd - nav.requestStart),
        // 响应耗时
        response: Math.round(nav.responseEnd - nav.responseStart),
        // DOM解析耗时
        domParse: Math.round(nav.domInteractive - nav.responseEnd),
        // DOM就绪耗时
        domReady: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
        // 页面完全加载耗时
        load: Math.round(nav.loadEventEnd - nav.startTime),
        // 首字节时间 (TTFB)
        ttfb: Math.round(nav.responseStart - nav.startTime),
        // 白屏时间（近似：responseEnd 到 domInteractive）
        whiteScreen: Math.round(nav.responseEnd - nav.startTime),
        // 导航类型
        navType: nav.type === 'navigate' ? '正常导航' :
                 nav.type === 'reload' ? '刷新' :
                 nav.type === 'back_forward' ? '后退/前进' :
                 nav.type === 'prerender' ? '预渲染' : '其他',
      };
    };

    // 延迟执行，确保页面加载完成
    const timer = setTimeout(() => {
      const metrics = getPerformanceMetrics();
      const isLowEnd = isLowEndDevice();

      if (metrics && metrics.load > 0) {
        console.group(`📊 性能报告 - ${pageName}`);
        console.log(`🖥️  设备类型: ${isLowEnd ? '⚠️  低端设备' : '✅ 正常设备'}`);
        console.log(`🌐 DNS查询: ${metrics.dns}ms`);
        console.log(`🔌 TCP连接: ${metrics.tcp}ms`);
        console.log(`📡 TTFB: ${metrics.ttfb}ms ${metrics.ttfb > 600 ? '⚠️  较慢' : '✅'}`);
        console.log(`⚪ 白屏时间: ${metrics.whiteScreen}ms ${metrics.whiteScreen > 1000 ? '⚠️  较慢' : '✅'}`);
        console.log(`📄 DOM就绪: ${metrics.domReady}ms ${metrics.domReady > 2000 ? '⚠️  较慢' : '✅'}`);
        console.log(`✅ 完全加载: ${metrics.load}ms ${metrics.load > 3000 ? '⚠️  较慢' : '✅'}`);
        console.log(`🧭 导航类型: ${metrics.navType}`);
        
        // 性能评分
        let score = 100;
        if (metrics.ttfb > 600) score -= 10;
        if (metrics.whiteScreen > 1000) score -= 15;
        if (metrics.domReady > 2000) score -= 15;
        if (metrics.load > 3000) score -= 20;
        if (isLowEnd) score -= 10;
        
        const getGrade = (s: number) => {
          if (s >= 90) return { grade: 'A', emoji: '🏆', color: '#10b981' };
          if (s >= 80) return { grade: 'B', emoji: '👍', color: '#3b82f6' };
          if (s >= 70) return { grade: 'C', emoji: '⚠️ ', color: '#f59e0b' };
          return { grade: 'D', emoji: '❌', color: '#ef4444' };
        };
        
        const grade = getGrade(score);
        console.log(`%c${grade.emoji} 性能评分: ${score}/100 (${grade.grade}级)`, `color: ${grade.color}; font-weight: bold; font-size: 14px;`);
        console.groupEnd();
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [pageName]);
}
